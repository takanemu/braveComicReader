import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react'
import ComicViewerCarousel from './components/ComicViewerCarousel'

const MENU_ITEMS = [
  { id: 'archive', label: 'Open archive' },
  { id: 'bookmarks', label: 'Show bookmarks' },
  { id: 'jump', label: 'Jump to page' },
  { id: 'settings', label: 'Settings' },
] as const

type CacheMode = 'nearby' | 'fullArchive'
type PageTransition = 'cut' | 'crossDissolve'

type AppSettings = {
  cacheMode: CacheMode
  spreadMode: boolean
  pageTransition: PageTransition
}

type ArchiveInfo = {
  page_count: number
  page_names: string[]
}

type Bookmark = {
  id: string
  archive_id: string
  page_index: number
  page_name: string
  created_at: string
}

type LastReadPage = {
  page_index: number
  page_name: string
}

type PagePayload = {
  name: string
  data: number[]
  mime_type: string
}

type ArchiveProgress = {
  loaded: number
  total: number
}

type ThumbnailItemProps = {
  index: number
  name: string
  pageThumbnail: string
  pageLoaded: boolean
  isActive: boolean
  isBookmarked: boolean
  onSelect: (index: number) => void
}

const THUMBNAIL_WIDTH = 88
const THUMBNAIL_HEIGHT = 128
const THUMBNAIL_MAX_DIMENSION = 128
const SCROLL_IDLE_DELAY_MS = 150
const MAX_THUMBNAIL_IN_FLIGHT = 1

const getSpreadPartnerIndex = (pageIndex: number, pageCount: number): number | null => {
  const partnerIndex = pageIndex % 2 === 0 ? pageIndex + 1 : pageIndex - 1
  return partnerIndex >= 0 && partnerIndex < pageCount ? partnerIndex : null
}

const ThumbnailItem: FC<ThumbnailItemProps> = memo(({ index, name, pageThumbnail, pageLoaded, isActive, isBookmarked, onSelect }) => {
  return (
    <button
      type="button"
      onClick={() => onSelect(index)}
      className={`group relative flex w-[88px] flex-col overflow-hidden rounded-xl border bg-slate-950/90 transition ${isActive ? 'ring-2 ring-cyan-500/80 border-cyan-500/70' : 'border-slate-700 hover:border-slate-500'}`}
      aria-label={`Load page ${index + 1}`}
    >
      <div className="relative overflow-hidden rounded-t-xl bg-slate-900" style={{ width: `${THUMBNAIL_WIDTH}px`, height: `${THUMBNAIL_HEIGHT}px` }}>
        {isBookmarked ? (
          <svg
            aria-label="Bookmarked"
            role="img"
            viewBox="0 0 24 24"
            className="absolute left-1.5 top-1.5 z-10 h-5 w-5 text-amber-400 drop-shadow-md"
            fill="currentColor"
          >
            <path d="M6 3.75A1.75 1.75 0 0 1 7.75 2h8.5A1.75 1.75 0 0 1 18 3.75V22l-6-4-6 4V3.75Z" />
          </svg>
        ) : null}
        {pageThumbnail ? (
          <img
            src={pageThumbnail}
            alt={name}
            loading="lazy"
            className="h-full w-full object-contain transition duration-200 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-[10px] text-slate-500">
            <span>Loading...</span>
            {pageLoaded ? <span>Decoding...</span> : <span>Queued</span>}
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/45 px-2 py-1 text-center text-[10px] font-medium text-slate-100">
        Page {index + 1}
      </div>
    </button>
  )
})

type ExtractedZipThumbnail = {
  name: string
  path: string
  mime_type: string
}

type IndexRange = {
  start: number
  end: number
}

const getTimestamp = () => {
  const d = new Date();
  const YYYY = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const SSS = String(d.getMilliseconds()).padStart(3, '0');
  return `${YYYY}/${MM}/${DD} ${hh}:${mm}:${ss}.${SSS}`;
};

const getPrefetchKey = (path: string, pageIndex: number) => `${path}::${pageIndex}`

const getPageRenderSize = (
  resolution: { width: number; height: number },
  isSpread: boolean,
) => {
  const pixelRatio = window.devicePixelRatio || 1
  const width = resolution.width || Math.ceil(window.innerWidth * pixelRatio)
  const height = resolution.height || Math.ceil(window.innerHeight * pixelRatio)
  return {
    maxWidth: Math.max(1, Math.ceil(isSpread ? width / 2 : width)),
    maxHeight: Math.max(1, height),
  }
}

const getDirectionalDistance = (index: number, anchor: number, direction: 1 | -1, pageCount: number) => {
  const distance = (index - anchor) * direction
  return distance >= 0 ? distance : pageCount + distance
}

const buildContinuousRanges = (indices: number[]): IndexRange[] => {
  if (indices.length === 0) {
    return []
  }

  const ranges: IndexRange[] = []
  let rangeStart = indices[0]
  let previous = indices[0]

  for (let index = 1; index < indices.length; index += 1) {
    const current = indices[index]
    if (current === previous + 1) {
      previous = current
      continue
    }

    ranges.push({ start: rangeStart, end: previous + 1 })
    rangeStart = current
    previous = current
  }

  ranges.push({ start: rangeStart, end: previous + 1 })
  return ranges
}

const App: FC = () => {
  const [archivePath, setArchivePath] = useState<string | null>(null)
  const [archiveError, setArchiveError] = useState('')
  const [isArchiveDragOver, setIsArchiveDragOver] = useState(false)
  const [archiveId, setArchiveId] = useState<string | null>(null)
  const archiveIdRef = useRef<string | null>(null)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [isBookmarksOpen, setIsBookmarksOpen] = useState(false)
  const [isThumbnailPaneOpen, setIsThumbnailPaneOpen] = useState(false)
  const [isTogglingBookmark, setIsTogglingBookmark] = useState(false)
  const [bookmarkError, setBookmarkError] = useState('')
  const [pageNames, setPageNames] = useState<string[]>([])
  const [pageThumbnails, setPageThumbnails] = useState<string[]>([])
  const [pageLoaded, setPageLoaded] = useState<boolean[]>([])
  const [renderResolution, setRenderResolution] = useState({ width: 0, height: 0 })
  const [cachedPages, setCachedPages] = useState<boolean[]>([])
  const [pageIndex, setPageIndex] = useState(0)
  const [pageCount, setPageCount] = useState(0)
  const pageCountRef = useRef(0)
  const [cacheMode, setCacheMode] = useState<CacheMode>('nearby')
  const [cacheModeDraft, setCacheModeDraft] = useState<CacheMode>('nearby')
  const cacheModeRef = useRef<CacheMode>('nearby')
  const [spreadMode, setSpreadMode] = useState(false)
  const [spreadModeDraft, setSpreadModeDraft] = useState(false)
  const [pageTransition, setPageTransition] = useState<PageTransition>('crossDissolve')
  const [pageTransitionDraft, setPageTransitionDraft] = useState<PageTransition>('crossDissolve')
  const pageStep = spreadMode ? 2 : 1
  const spreadModeRef = useRef(false)
  const fullArchivePrefetchPathRef = useRef<string | null>(null)
  const fullArchivePrefetchGenerationRef = useRef(0)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isSavingSettings, setIsSavingSettings] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [isPageJumpOpen, setIsPageJumpOpen] = useState(false)
  const [pageJumpInput, setPageJumpInput] = useState('')
  const [pageJumpError, setPageJumpError] = useState('')
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const imageUrlRef = useRef<string | null>(null)
  const [spreadPage, setSpreadPage] = useState<{ index: number; url: string } | null>(null)
  const pageThumbnailUrlsRef = useRef<string[]>([])
  const thumbnailsContainerRef = useRef<HTMLDivElement | null>(null)
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 })
  const [thumbnailViewportRange, setThumbnailViewportRange] = useState({ start: 0, end: 0 })
  const [committedVisibleRange, setCommittedVisibleRange] = useState({ start: 0, end: 0 })
  const pendingThumbnailRequestRef = useRef<Set<number>>(new Set())
  const thumbnailQueueRef = useRef<number[]>([])
  const inFlightThumbnailKeysRef = useRef<Set<number>>(new Set())
  const pageLoadedRef = useRef<boolean[]>([])
  const cachedPagesRef = useRef<boolean[]>([])
  const startTimeRef = useRef<number>(Date.now())
  const [isLoading, setIsLoading] = useState(false)
  const archivePathRef = useRef<string | null>(null)
  const loadArchiveRef = useRef<((path: string) => Promise<void>) | null>(null)
  const loadPageRef = useRef<((path: string, pageIndex: number) => Promise<void>) | null>(null)
  const pageIndexRef = useRef(0)
  const viewerSectionRef = useRef<HTMLElement | null>(null)
  const lastPdfResolutionRef = useRef<string | null>(null)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isHeaderHovered, setIsHeaderHovered] = useState(false)
  //const [progress, setProgress] = useState<ArchiveProgress | null>(null)
  const [isArchiveReady, setIsArchiveReady] = useState(false)
  const [isScrolling, setIsScrolling] = useState(false)
  const [pageLoadCount, setPageLoadCount] = useState(0)
  const listenersReadyRef = useRef<Promise<void>>(Promise.resolve())
  const scrollIdleTimerRef = useRef<number | null>(null)
  const pageLoadsInFlightRef = useRef(0)
  const thumbnailPriorityDirectionRef = useRef<1 | -1>(1)
  const isScrollingRef = useRef(false)
  const latestVisibleRangeRef = useRef({ start: 0, end: 0 })
  const prefetchedPageKeysRef = useRef<Set<string>>(new Set())
  const inFlightPrefetchKeysRef = useRef<Set<string>>(new Set())
  const [extractedThumbnails, setExtractedThumbnails] = useState<ExtractedZipThumbnail[]>([])

  useEffect(() => {
    const element = viewerSectionRef.current
    if (!element) {
      return
    }

    const updateResolution = () => {
      const bounds = element.getBoundingClientRect()
      const pixelRatio = window.devicePixelRatio || 1
      const nextResolution = {
        width: Math.max(1, Math.ceil(bounds.width * pixelRatio)),
        height: Math.max(1, Math.ceil(bounds.height * pixelRatio)),
      }
      setRenderResolution((current) => (
        current.width === nextResolution.width && current.height === nextResolution.height
          ? current
          : nextResolution
      ))
    }

    const observer = new ResizeObserver(updateResolution)
    observer.observe(element)
    window.addEventListener('resize', updateResolution)
    updateResolution()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateResolution)
    }
  }, [])

  useEffect(() => {
    let isMounted = true
    void invoke<AppSettings>('load_settings')
      .then((settings) => {
        if (isMounted) {
          console.info('[cache] loaded cache mode', settings.cacheMode)
          cacheModeRef.current = settings.cacheMode
          setCacheMode(settings.cacheMode)
          setSpreadMode(settings.spreadMode)
          setPageTransition(settings.pageTransition)
        }
      })
      .catch((error) => {
        console.error('Failed to load settings', error)
      })
    return () => {
      isMounted = false
    }
  }, [])

  const markPagesCached = useCallback((indices: Iterable<number>) => {
    const next = [...cachedPagesRef.current]
    let changed = false
    for (const index of indices) {
      if (index >= 0 && index < next.length && !next[index]) {
        next[index] = true
        changed = true
      }
    }
    if (changed) {
      cachedPagesRef.current = next
      setCachedPages(next)
    }
  }, [])

  const cachedPageRanges = useMemo(() => {
    const cachedIndices = cachedPages.flatMap((isCached, index) => isCached ? [index] : [])
    return buildContinuousRanges(cachedIndices)
  }, [cachedPages])
  const cachedPageCount = useMemo(() => cachedPages.filter(Boolean).length, [cachedPages])

  useEffect(() => {
    pageLoadedRef.current = pageLoaded
  }, [pageLoaded])

  useEffect(() => {
    return () => {
      if (scrollIdleTimerRef.current !== null) {
        window.clearTimeout(scrollIdleTimerRef.current)
      }
      if (imageUrl) {
        window.setTimeout(() => URL.revokeObjectURL(imageUrl), 550)
      }
    }
  }, [imageUrl])

  useEffect(() => {
    imageUrlRef.current = imageUrl
  }, [imageUrl])

  useEffect(() => {
    if (!spreadPage) {
      return
    }
    return () => {
      window.setTimeout(() => URL.revokeObjectURL(spreadPage.url), 550)
    }
  }, [spreadPage])

  useEffect(() => {
    spreadModeRef.current = spreadMode
    if (!spreadMode) {
      setSpreadPage(null)
    }
  }, [spreadMode])

  useEffect(() => {
    setSpreadPage(null)
  }, [archivePath])

  useEffect(() => {
    return () => {
      pageThumbnailUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      pageThumbnailUrlsRef.current = []
    }
  }, [])

  useEffect(() => {
    let progressUnlisten: (() => void) | undefined
    let thumbnailUnlisten: (() => void) | undefined
    let resolveListenersReady: (() => void) | undefined
    listenersReadyRef.current = new Promise<void>((resolve) => {
      resolveListenersReady = resolve
    })

    const setupListener = async () => {
      console.log(`[${Date.now() - startTimeRef.current}ms] frontend: setting up event listeners`)

      progressUnlisten = await listen<ArchiveProgress>('archive-progress', (event) => {
        //console.log(`[${Date.now() - startTimeRef.current}ms] frontend: archive-progress ${event.payload.loaded}/${event.payload.total}`)
        console.log(`[${getTimestamp()}] frontend: archive-progress ${event.payload.loaded}/${event.payload.total}`);
        //setProgress(event.payload)
        //setStatus(`Expanding pages ${event.payload.loaded}/${event.payload.total}...`)
      })

      thumbnailUnlisten = await listen<{ thumbnails: { index: number; name: string; data: number[]; mime_type: string }[] }>('archive-page-thumbnail-batch', (event) => {
        const { thumbnails } = event.payload
        if (thumbnails.length === 0) {
          return
        }
        console.log(`[${Date.now() - startTimeRef.current}ms] frontend: archive-page-thumbnail-batch count=${thumbnails.length} start=${thumbnails[0].index}`)

        const urlsByIndex = new Map<number, string>()
        for (const { index, data, mime_type } of thumbnails) {
          const bytes = Uint8Array.from(data)
          const blob = new Blob([bytes], { type: mime_type })
          const url = URL.createObjectURL(blob)

          const previousUrl = pageThumbnailUrlsRef.current[index]
          if (previousUrl) {
            URL.revokeObjectURL(previousUrl)
          }
          if (pageThumbnailUrlsRef.current.length <= index) {
            pageThumbnailUrlsRef.current.length = index + 1
          }
          pageThumbnailUrlsRef.current[index] = url
          urlsByIndex.set(index, url)
          pendingThumbnailRequestRef.current.delete(index)
        }

        setPageThumbnails((prev) => {
          const maxIndex = Math.max(prev.length - 1, ...urlsByIndex.keys())
          const next = prev.length > maxIndex ? [...prev] : [...prev, ...Array(maxIndex + 1 - prev.length).fill('')]
          urlsByIndex.forEach((url, index) => {
            next[index] = url
          })
          return next
        })
        markPagesCached(urlsByIndex.keys())
        setPageLoaded((prev) => {
          const maxIndex = Math.max(prev.length - 1, ...urlsByIndex.keys())
          const next = prev.length > maxIndex ? [...prev] : [...prev, ...Array(maxIndex + 1 - prev.length).fill(false)]
          urlsByIndex.forEach((_url, index) => {
            next[index] = true
          })
          return next
        })

        if (archivePathRef.current && urlsByIndex.has(pageIndexRef.current)) {
          void loadPage(archivePathRef.current, pageIndexRef.current)
        }
      })

      await listen<ExtractedZipThumbnail>('zip-thumbnail-extracted', (event) => {
        const thumbnail = event.payload
        setExtractedThumbnails((prev) => {
          const next = [...prev]
          next.push(thumbnail)
          return next
        })
        //setStatus(`Received ${thumbnail.name}...`)
      })

      resolveListenersReady?.()
    }

    void setupListener()

    return () => {
      if (progressUnlisten) {
        progressUnlisten()
      }
      if (thumbnailUnlisten) {
        thumbnailUnlisten()
      }
    }
  }, [markPagesCached])

  const currentPageLabel = useMemo(() => {
    if (pageCount === 0) {
      return '000/000'
    }
    return `${String(pageIndex + 1).padStart(3, '0')}/${String(pageCount).padStart(3, '0')}`
  }, [pageCount, pageIndex])
  const isCurrentPageBookmarked = bookmarks.some((bookmark) => bookmark.page_index === pageIndex)
  const bookmarkedPageIndices = useMemo(
    () => new Set(bookmarks.map((bookmark) => bookmark.page_index)),
    [bookmarks],
  )

  const loadArchive = async (path: string) => {
    setIsLoading(true)
    setArchiveError('')
    //setStatus(`Loading ${path}...`)
    //setProgress(null)
    setIsArchiveReady(false)

    try {
      setArchivePath(path)
      setIsThumbnailPaneOpen(true)
      setArchiveId(null)
      archiveIdRef.current = null
      setBookmarks([])
      setBookmarkError('')
      archivePathRef.current = path
      setPageCount(0)
      pageCountRef.current = 0
      setPageNames([])
      setPageIndex(0)
      pageIndexRef.current = 0
      fullArchivePrefetchGenerationRef.current += 1
      fullArchivePrefetchPathRef.current = null
      thumbnailPriorityDirectionRef.current = 1
      pageThumbnailUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      pageThumbnailUrlsRef.current = []
      setPageThumbnails([])
      setPageLoaded([])
      cachedPagesRef.current = []
      setCachedPages([])
      prefetchedPageKeysRef.current.clear()
      inFlightPrefetchKeysRef.current.clear()
      pendingThumbnailRequestRef.current.clear()
      thumbnailQueueRef.current = []
      inFlightThumbnailKeysRef.current.clear()
      //setProgress({ loaded: 0, total: 0 })

      if (path) {
        archivePathRef.current = path
        pageIndexRef.current = 0
        //setStatus('Scanning archive pages...')
        await listenersReadyRef.current
        console.log(`[${Date.now() - startTimeRef.current}ms] frontend: invoking preload_archive`)
        const info = await invoke<ArchiveInfo>('preload_archive', { path })
        console.log(`[${Date.now() - startTimeRef.current}ms] frontend: preload_archive returned page_count=${info.page_count}`)
        setPageCount(info.page_count)
        pageCountRef.current = info.page_count
        setPageNames(info.page_names)
        pageThumbnailUrlsRef.current = Array(info.page_count).fill('')
        setPageThumbnails(Array(info.page_count).fill(''))
        setPageLoaded(Array(info.page_count).fill(false))
        cachedPagesRef.current = Array(info.page_count).fill(false)
        setCachedPages(cachedPagesRef.current)
        setIsArchiveReady(true)
        let initialPageIndex = 0
        try {
          const identity = await invoke<{ id: string }>('identify_archive', { path })
          if (archivePathRef.current === path) {
            archiveIdRef.current = identity.id
            setArchiveId(identity.id)
            const [savedBookmarks, lastReadPage] = await Promise.all([
              invoke<Bookmark[]>('list_bookmarks', { archiveId: identity.id }),
              invoke<LastReadPage | null>('get_last_read_page', { archiveId: identity.id }),
            ])
            if (archiveIdRef.current === identity.id) {
              setBookmarks(savedBookmarks)
              if (lastReadPage) {
                const pageByName = info.page_names.indexOf(lastReadPage.page_name)
                initialPageIndex = pageByName >= 0
                  ? pageByName
                  : lastReadPage.page_index < info.page_count
                    ? lastReadPage.page_index
                    : 0
              }
            }
          }
        } catch (error) {
          if (archivePathRef.current === path) {
            setBookmarkError('Unable to load saved archive data.')
          }
          console.error('Failed to identify archive or load saved data', { path, error })
        }
        //setProgress({ loaded: info.page_count, total: info.page_count })

        if (info.page_count > 0) {
          if (archivePathRef.current === path) {
            pageIndexRef.current = initialPageIndex
            setPageIndex(initialPageIndex)
            void loadPage(path, initialPageIndex)
          }
        } else {
          //setStatus('The archive did not contain readable image pages.')
        }
      } else {
        setIsArchiveReady(true)
        //setStatus('The archive did not contain readable image pages.')
      }
    } catch (error) {
      console.error('Failed to load archive', { path, error })
      setArchivePath(null)
      archivePathRef.current = null
      setArchiveError('Unable to open this file. Check that it is a supported PDF or archive.')
    } finally {
      setIsLoading(false)
    }
  }

  loadArchiveRef.current = loadArchive

  useEffect(() => {
    let isMounted = true
    void invoke<string | null>('get_startup_archive_path')
      .then((path) => {
        if (!isMounted || !path) {
          return
        }
        const loadArchive = loadArchiveRef.current
        if (!loadArchive) {
          console.error('Archive loader is not ready')
          return
        }
        return loadArchive(path)
      })
      .catch((error) => {
        console.error('Failed to open startup archive', error)
      })
    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    let isMounted = true
    let unlisten: (() => void) | null = null

    void getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === 'enter') {
        setIsArchiveDragOver(true)
        return
      }
      if (payload.type === 'leave') {
        setIsArchiveDragOver(false)
        return
      }
      if (payload.type !== 'drop') {
        return
      }

      setIsArchiveDragOver(false)
      if (payload.paths.length !== 1) {
        setArchiveError('Drop one archive at a time.')
        return
      }

      const loadArchive = loadArchiveRef.current
      if (!loadArchive) {
        console.error('Archive loader is not ready')
        setArchiveError('Unable to open the dropped archive.')
        return
      }
      void loadArchive(payload.paths[0])
    }).then((stopListening) => {
      if (isMounted) {
        unlisten = stopListening
      } else {
        stopListening()
      }
    }).catch((error) => {
      console.error('Failed to listen for archive drops', error)
    })

    return () => {
      isMounted = false
      unlisten?.()
    }
  }, [])

  const selectArchive = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: 'Archive',
            extensions: [
              'pdf', 'zip', 'cbz', '7z', 'cb7', 'rar', 'cbr', 'tar', 'tar.gz', 'tgz', 'gz',
              'tar.bz2', 'tbz', 'tbz2', 'bz2', 'tar.xz', 'txz', 'xz', 'tar.zst', 'tar.zstd', 'zst',
              'PDF', 'ZIP', 'CBZ', '7Z', 'CB7', 'RAR', 'CBR', 'TAR', 'TAR.GZ', 'TGZ', 'GZ',
              'TAR.BZ2', 'TBZ', 'TBZ2', 'BZ2', 'TAR.XZ', 'TXZ', 'XZ', 'TAR.ZST', 'TAR.ZSTD', 'ZST',
            ],
          }
        ]
      })
      if (!selected) {
        return
      }

      const selectedPath = Array.isArray(selected) ? selected[0] : selected
      if (typeof selectedPath !== 'string' || !selectedPath) {
        return
      }

      await loadArchive(selectedPath)
    } catch (error) {
      console.error('Failed to load archive', error)
      //setStatus('Failed to load archive.')
    }
  }, [loadArchive])

  const loadThumbnailPage = useCallback(async (path: string, index: number) => {
    if (!path || index < 0 || index >= pageNames.length) {
      return
    }

    try {
      const payload = await invoke<PagePayload>('get_page', {
        path,
        pageIndex: index,
        maxWidth: THUMBNAIL_MAX_DIMENSION,
        maxHeight: THUMBNAIL_MAX_DIMENSION,
      })
      if (archivePathRef.current === path) {
        markPagesCached([index])
      }
      const bytes = Uint8Array.from(payload.data)
      const blob = new Blob([bytes], { type: payload.mime_type })
      const nextUrl = URL.createObjectURL(blob)

      const previousUrl = pageThumbnailUrlsRef.current[index]
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl)
      }

      pageThumbnailUrlsRef.current[index] = nextUrl
      setPageThumbnails((prev) => {
        const next = [...prev]
        next[index] = nextUrl
        return next
      })
      setPageLoaded((prev) => {
        const next = [...prev]
        next[index] = true
        return next
      })
    } catch (error) {
      console.debug('Thumbnail page load failed', { path, index, error })
    } finally {
      pendingThumbnailRequestRef.current.delete(index)
      inFlightThumbnailKeysRef.current.delete(index)
      if (!isScrollingRef.current && archivePath) {
        void flushThumbnailQueue()
      }
    }
  }, [archivePath, markPagesCached, pageNames.length])

  const flushThumbnailQueue = useCallback(() => {
    if (!archivePath || isScrollingRef.current || pageLoadsInFlightRef.current > 0) {
      return
    }

    const availableSlots = MAX_THUMBNAIL_IN_FLIGHT - inFlightThumbnailKeysRef.current.size
    if (availableSlots <= 0) {
      return
    }

    const readyIndices = thumbnailQueueRef.current
      .filter((index) => !inFlightThumbnailKeysRef.current.has(index))
      .sort((left, right) => (
        getDirectionalDistance(left, pageIndexRef.current, thumbnailPriorityDirectionRef.current, pageCount)
        - getDirectionalDistance(right, pageIndexRef.current, thumbnailPriorityDirectionRef.current, pageCount)
      ))
      .slice(0, availableSlots)

    for (const index of readyIndices) {
      thumbnailQueueRef.current = thumbnailQueueRef.current.filter((queuedIndex) => queuedIndex !== index)
      inFlightThumbnailKeysRef.current.add(index)
      void loadThumbnailPage(archivePath, index)
    }
  }, [archivePath, loadThumbnailPage, pageCount])

  useEffect(() => {
    if (pageLoadCount === 0 && archivePath && !isScrolling) {
      flushThumbnailQueue()
    }
  }, [archivePath, flushThumbnailQueue, isScrolling, pageLoadCount])

  const requestThumbnailRange = useCallback((startIndex: number, count: number) => {
    if (count <= 0 || !archivePath) {
      return
    }

    const endIndex = Math.min(pageNames.length, startIndex + count)
    if (endIndex <= startIndex) {
      return
    }

    const nextIndices: number[] = []
    for (let index = startIndex; index < endIndex; index += 1) {
      if (pageLoaded[index] || pendingThumbnailRequestRef.current.has(index) || inFlightThumbnailKeysRef.current.has(index)) {
        continue
      }
      nextIndices.push(index)
    }

    if (nextIndices.length === 0) {
      return
    }

    for (const index of nextIndices) {
      pendingThumbnailRequestRef.current.add(index)
    }

    thumbnailQueueRef.current = [...thumbnailQueueRef.current, ...nextIndices]
    flushThumbnailQueue()
  }, [archivePath, pageLoaded, pageNames.length, flushThumbnailQueue])

  const startFullArchivePrefetch = useCallback((path: string) => {
    const totalPages = pageCountRef.current
    if (
      cacheModeRef.current !== 'fullArchive'
      || archivePathRef.current !== path
      || totalPages === 0
      || pageLoadsInFlightRef.current > 0
      || inFlightPrefetchKeysRef.current.size > 0
      || fullArchivePrefetchPathRef.current === path
    ) {
      console.debug('[cache] full archive warmup not started', {
        mode: cacheModeRef.current,
        pathMatches: archivePathRef.current === path,
        totalPages,
        pageLoadsInFlight: pageLoadsInFlightRef.current,
        prefetchesInFlight: inFlightPrefetchKeysRef.current.size,
        alreadyStarted: fullArchivePrefetchPathRef.current === path,
      })
      return
    }

    fullArchivePrefetchPathRef.current = path
    const generation = ++fullArchivePrefetchGenerationRef.current
    const batchSize = 4
    console.info('[cache] full archive warmup started', { path, totalPages, batchSize })

    void (async () => {
      for (let startIndex = 0; startIndex < totalPages; startIndex += batchSize) {
        if (
          generation !== fullArchivePrefetchGenerationRef.current
          || cacheModeRef.current !== 'fullArchive'
          || archivePathRef.current !== path
        ) {
          break
        }

        const count = Math.min(batchSize, totalPages - startIndex)
        const indices = Array.from({ length: count }, (_, offset) => startIndex + offset)
        const renderSize = getPageRenderSize(renderResolution, spreadModeRef.current)
        indices.forEach((index) => inFlightPrefetchKeysRef.current.add(getPrefetchKey(path, index)))
        const batchStarted = performance.now()
        console.info('[cache] full archive batch started', { startIndex, count })

        try {
          await invoke('prefetch_page_range', { path, startIndex, count, ...renderSize })
          if (archivePathRef.current === path) {
            markPagesCached(indices)
            indices.forEach((index) => prefetchedPageKeysRef.current.add(getPrefetchKey(path, index)))
          }
          console.info('[cache] full archive batch completed', { startIndex, count, elapsedMs: Math.round(performance.now() - batchStarted) })
        } catch (error) {
          console.debug('Full archive cache batch skipped', { path, startIndex, count, error })
        } finally {
          indices.forEach((index) => inFlightPrefetchKeysRef.current.delete(getPrefetchKey(path, index)))
        }
      }
    })()
  }, [markPagesCached, renderResolution.height, renderResolution.width])

  const prefetchAroundPage = useCallback((path: string, centerIndex: number) => {
    const totalPages = pageCountRef.current
    if (!path || totalPages <= 0) {
      return
    }

    const direction = thumbnailPriorityDirectionRef.current
    const renderSize = getPageRenderSize(
      renderResolution,
      spreadModeRef.current || spreadPage !== null,
    )
    const targetIndices = (direction === 1
      ? [centerIndex + 1, centerIndex + 2, centerIndex - 1]
      : [centerIndex - 1, centerIndex - 2, centerIndex + 1]
    ).filter(
      (index) => index >= 0 && index < totalPages,
    )

    const pendingIndices = targetIndices
      .filter((index, position, arr) => arr.indexOf(index) === position)
      .filter((targetIndex) => {
        const key = getPrefetchKey(path, targetIndex)
        return !prefetchedPageKeysRef.current.has(key) && !inFlightPrefetchKeysRef.current.has(key)
      })

    console.info('[cache] nearby prefetch settled', { centerIndex, direction, pendingIndices })

    if (pendingIndices.length === 0) {
      startFullArchivePrefetch(path)
      return
    }

    const ranges: Array<{ startIndex: number; count: number; indices: number[] }> = []
    let rangeStart = pendingIndices[0]
    let previous = pendingIndices[0]

    for (let i = 1; i < pendingIndices.length; i += 1) {
      const current = pendingIndices[i]
      if (current === previous + 1) {
        previous = current
        continue
      }

      const indices = Array.from({ length: previous - rangeStart + 1 }, (_, offset) => rangeStart + offset)
      ranges.push({ startIndex: rangeStart, count: indices.length, indices })
      rangeStart = current
      previous = current
    }

    const lastIndices = Array.from({ length: previous - rangeStart + 1 }, (_, offset) => rangeStart + offset)
    ranges.push({ startIndex: rangeStart, count: lastIndices.length, indices: lastIndices })

    for (const range of ranges) {
      range.indices.forEach((index) => {
        inFlightPrefetchKeysRef.current.add(getPrefetchKey(path, index))
      })

      void invoke('prefetch_page_range', {
        path,
        startIndex: range.startIndex,
        count: range.count,
        ...renderSize,
      })
        .then(() => {
          if (archivePathRef.current === path) {
            markPagesCached(range.indices)
          }
          range.indices.forEach((index) => {
            prefetchedPageKeysRef.current.add(getPrefetchKey(path, index))
          })
        })
        .catch((error) => {
          console.debug('Page prefetch skipped', {
            path,
            startIndex: range.startIndex,
            count: range.count,
            error,
          })
        })
        .finally(() => {
          range.indices.forEach((index) => {
            inFlightPrefetchKeysRef.current.delete(getPrefetchKey(path, index))
          })
          if (inFlightPrefetchKeysRef.current.size === 0) {
            startFullArchivePrefetch(path)
          }
        })
    }
  }, [markPagesCached, renderResolution.height, renderResolution.width, spreadPage, startFullArchivePrefetch])

  useEffect(() => {
    if (cacheMode !== 'fullArchive' || !archivePath || !isArchiveReady || !imageUrl || pageLoadCount > 0 || isScrolling) {
      return
    }

    const path = archivePath
    const centerIndex = pageIndex
    const prefetchTimer = window.setTimeout(() => {
      if (pageLoadsInFlightRef.current === 0 && archivePathRef.current === path && !isScrollingRef.current) {
        prefetchAroundPage(path, centerIndex)
      }
    }, SCROLL_IDLE_DELAY_MS);

    return () => window.clearTimeout(prefetchTimer)
  }, [archivePath, cacheMode, imageUrl, isArchiveReady, isScrolling, pageIndex, pageLoadCount, prefetchAroundPage])

  const thumbnailItemHeight = THUMBNAIL_HEIGHT + 8
  const visibleBuffer = 6

  const updateVisibleRange = useCallback((nextRange: { start: number; end: number }) => {
    latestVisibleRangeRef.current = nextRange
    setVisibleRange((prev) => {
      if (prev.start === nextRange.start && prev.end === nextRange.end) {
        return prev
      }
      return nextRange
    })
  }, [])

  const commitVisibleRange = useCallback((nextRange: { start: number; end: number }) => {
    setCommittedVisibleRange((prev) => {
      if (prev.start === nextRange.start && prev.end === nextRange.end) {
        return prev
      }
      return nextRange
    })
  }, [])

  const virtualizer = useVirtualizer({
    count: pageNames.length,
    getScrollElement: () => thumbnailsContainerRef.current,
    estimateSize: () => thumbnailItemHeight,
    overscan: visibleBuffer,
  })

  const syncThumbnailViewportRange = useCallback(() => {
    const container = thumbnailsContainerRef.current
    if (!container || container.clientHeight <= 0) {
      setThumbnailViewportRange({ start: 0, end: 0 })
      return
    }

    const viewportTop = container.scrollTop
    const viewportBottom = viewportTop + container.clientHeight
    const visibleItems = virtualizer.getVirtualItems().filter(
      (item) => item.end > viewportTop && item.start < viewportBottom,
    )

    const nextRange = visibleItems.length > 0
      ? { start: visibleItems[0].index, end: visibleItems[visibleItems.length - 1].index + 1 }
      : { start: 0, end: 0 }

    setThumbnailViewportRange((previous) => (
      previous.start === nextRange.start && previous.end === nextRange.end ? previous : nextRange
    ))
  }, [virtualizer])

  const syncVisibleRangeFromVirtualizer = useCallback(() => {
    const items = virtualizer.getVirtualItems()
    if (items.length === 0) {
      const emptyRange = { start: 0, end: 0 }
      updateVisibleRange(emptyRange)
      if (!isScrollingRef.current) {
        commitVisibleRange(emptyRange)
      }
      return
    }

    const nextRange = {
      start: Math.max(0, items[0].index),
      end: Math.min(pageNames.length, items[items.length - 1].index + 1),
    }
    updateVisibleRange(nextRange)
    if (!isScrollingRef.current) {
      commitVisibleRange(nextRange)
    }
  }, [commitVisibleRange, pageNames.length, updateVisibleRange, virtualizer])

  useEffect(() => {
    syncVisibleRangeFromVirtualizer()
    syncThumbnailViewportRange()
  }, [syncThumbnailViewportRange, syncVisibleRangeFromVirtualizer])

  useEffect(() => {
    const container = thumbnailsContainerRef.current
    if (!container) {
      return
    }

    const handleResize = () => {
      virtualizer.measure()
      syncVisibleRangeFromVirtualizer()
      syncThumbnailViewportRange()
      if (archivePath) {
        flushThumbnailQueue()
      }
    }

    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(container)

    const handleScroll = () => {
      const items = virtualizer.getVirtualItems()
      if (items.length === 0) {
        return
      }

      if (!isScrollingRef.current) {
        isScrollingRef.current = true
        setIsScrolling(true)
      }

      const nextRange = {
        start: Math.max(0, items[0].index),
        end: Math.min(pageNames.length, items[items.length - 1].index + 1),
      }
      updateVisibleRange(nextRange)
      syncThumbnailViewportRange()

      if (scrollIdleTimerRef.current !== null) {
        window.clearTimeout(scrollIdleTimerRef.current)
      }

      scrollIdleTimerRef.current = window.setTimeout(() => {
        isScrollingRef.current = false
        setIsScrolling(false)
        commitVisibleRange(latestVisibleRangeRef.current)
        scrollIdleTimerRef.current = null
        if (archivePath) {
          flushThumbnailQueue()
        }
      }, SCROLL_IDLE_DELAY_MS)
    }

    container.addEventListener('scroll', handleScroll)
    return () => {
      resizeObserver.disconnect()
      container.removeEventListener('scroll', handleScroll)
      if (scrollIdleTimerRef.current !== null) {
        window.clearTimeout(scrollIdleTimerRef.current)
        scrollIdleTimerRef.current = null
      }
      isScrollingRef.current = false
      setIsScrolling(false)
    }
  }, [archivePath, commitVisibleRange, flushThumbnailQueue, pageNames.length, syncThumbnailViewportRange, syncVisibleRangeFromVirtualizer, updateVisibleRange, virtualizer])

  // Only fetch thumbnails that are actually inside the virtualized visible range.
  // This keeps the UI responsive and avoids preloading the whole archive when
  // the user is only browsing a small slice of pages.
  useEffect(() => {
    if (!archivePath || pageNames.length === 0 || !isArchiveReady) {
      return
    }

    requestThumbnailRange(0, 1)

    if (isScrolling) {
      return
    }

    const { start, end } = committedVisibleRange
    if (start >= end) {
      return
    }

    const missingIndices: number[] = []
    for (let index = start; index < end; index += 1) {
      if (!pageLoaded[index] && !pendingThumbnailRequestRef.current.has(index)) {
        missingIndices.push(index)
      }
    }

    if (missingIndices.length === 0) {
      return
    }

    const missingRanges = buildContinuousRanges(missingIndices)
    for (const range of missingRanges) {
      requestThumbnailRange(range.start, range.end - range.start)
    }
  }, [archivePath, pageNames.length, pageLoaded, committedVisibleRange, isArchiveReady, isScrolling, requestThumbnailRange])

  const loadPage = async (path: string, nextIndex: number) => {
    //setStatus(`Loading page ${nextIndex + 1}...`)
    thumbnailPriorityDirectionRef.current = nextIndex === pageCount - 1 ? -1 : 1
    pageLoadsInFlightRef.current += 1
    setPageLoadCount(pageLoadsInFlightRef.current)

    try {
      console.time("1. invoke get_page");
      const partnerIndex = spreadModeRef.current ? getSpreadPartnerIndex(nextIndex, pageCount) : null
      const renderSize = getPageRenderSize(
        renderResolution,
        spreadModeRef.current || spreadPage !== null,
      )
      const resolutionKey = `${path}:${renderSize.maxWidth}x${renderSize.maxHeight}`
      if (path.toLowerCase().endsWith('.pdf')) {
        lastPdfResolutionRef.current = resolutionKey
      }
      const [payload, partnerPayload] = await Promise.all([
        invoke<PagePayload>('get_page', { path, pageIndex: nextIndex, ...renderSize }),
        partnerIndex === null
          ? Promise.resolve(null)
          : invoke<PagePayload>('get_page', { path, pageIndex: partnerIndex, ...renderSize }).catch(() => null),
      ])
      console.timeEnd("1. invoke get_page");
      if (archivePathRef.current === path) {
        markPagesCached([nextIndex])
      }

      console.time("2. Uint8Array & Blob");
      const bytes = Uint8Array.from(payload.data)
      const blob = new Blob([bytes], { type: payload.mime_type })
      const nextUrl = URL.createObjectURL(blob)

      if (archivePathRef.current === path && pageThumbnailUrlsRef.current.length > nextIndex) {
        const thumbnailUrl = URL.createObjectURL(blob)
        const previousThumbnailUrl = pageThumbnailUrlsRef.current[nextIndex]
        if (previousThumbnailUrl) {
          URL.revokeObjectURL(previousThumbnailUrl)
        }
        pageThumbnailUrlsRef.current[nextIndex] = thumbnailUrl
        pendingThumbnailRequestRef.current.delete(nextIndex)
        thumbnailQueueRef.current = thumbnailQueueRef.current.filter((index) => index !== nextIndex)
        setPageThumbnails((previous) => {
          const next = [...previous]
          next[nextIndex] = thumbnailUrl
          return next
        })
        setPageLoaded((previous) => {
          const next = [...previous]
          next[nextIndex] = true
          return next
        })
      }

      console.timeEnd("2. Uint8Array & Blob");

      console.time("3. React State Update & Render");
      setImageUrl(nextUrl)
      if (spreadModeRef.current) {
        setSpreadPage(
          partnerPayload && partnerIndex !== null
            ? {
                index: partnerIndex,
                url: URL.createObjectURL(new Blob([Uint8Array.from(partnerPayload.data)], { type: partnerPayload.mime_type })),
              }
            : null,
        )
      }
      requestAnimationFrame(() => {
        console.timeEnd("3. React State Update & Render");
      });
      setPageIndex(nextIndex)
      pageIndexRef.current = nextIndex
      const currentArchiveId = archiveIdRef.current
      if (currentArchiveId && archivePathRef.current === path) {
        void invoke('save_last_read_page', {
          archiveId: currentArchiveId,
          pageIndex: nextIndex,
          pageName: payload.name,
        }).catch((error: unknown) => {
          console.error('Failed to save last read page', {
            archiveId: currentArchiveId,
            pageIndex: nextIndex,
            error,
          })
        })
      }
      //setStatus(payload.name)
    } catch (error) {
      console.error('Failed to load page', { path, pageIndex: nextIndex, error })
    } finally {
      pageLoadsInFlightRef.current = Math.max(0, pageLoadsInFlightRef.current - 1)
      setPageLoadCount(pageLoadsInFlightRef.current)
      if (pageLoadsInFlightRef.current === 0 && !isScrollingRef.current) {
        void flushThumbnailQueue()
      }
    }
  }

  loadPageRef.current = loadPage

  useEffect(() => {
    if (
      !isArchiveReady
      || !archivePath?.toLowerCase().endsWith('.pdf')
      || renderResolution.width === 0
      || renderResolution.height === 0
    ) {
      return
    }

    const renderSize = getPageRenderSize(
      renderResolution,
      spreadModeRef.current || spreadPage !== null,
    )
    const resolutionKey = `${archivePath}:${renderSize.maxWidth}x${renderSize.maxHeight}`
    if (lastPdfResolutionRef.current === resolutionKey) {
      return
    }

    const timer = window.setTimeout(() => {
      const reloadPage = loadPageRef.current
      if (reloadPage && archivePathRef.current === archivePath) {
        void reloadPage(archivePath, pageIndexRef.current)
      }
    }, 200)
    return () => window.clearTimeout(timer)
  }, [archivePath, isArchiveReady, renderResolution.height, renderResolution.width, spreadPage])

  const discardQueuedThumbnailRequests = useCallback(() => {
    for (const index of thumbnailQueueRef.current) {
      if (!inFlightThumbnailKeysRef.current.has(index)) {
        pendingThumbnailRequestRef.current.delete(index)
      }
    }
    thumbnailQueueRef.current = []
  }, [])

  const navigateToPage = useCallback((path: string, nextIndex: number) => {
    if (!path || nextIndex < 0 || nextIndex >= pageCount || nextIndex === pageIndexRef.current) {
      return
    }

    discardQueuedThumbnailRequests()
    if (!spreadModeRef.current) {
      setSpreadPage(null)
    }
    virtualizer.scrollToIndex(nextIndex, { align: 'auto' })
    void loadPage(path, nextIndex)
  }, [discardQueuedThumbnailRequests, pageCount, virtualizer])

  const openSpread = useCallback(async (offset: -1 | 1) => {
    const path = archivePathRef.current
    const baseIndex = pageIndexRef.current
    const partnerIndex = baseIndex + offset
    if (!path || partnerIndex < 0 || partnerIndex >= pageCount) {
      return
    }

    try {
      const renderSize = getPageRenderSize(renderResolution, true)
      const payload = await invoke<PagePayload>('get_page', {
        path,
        pageIndex: partnerIndex,
        ...renderSize,
      })
      if (archivePathRef.current !== path || pageIndexRef.current !== baseIndex) {
        return
      }
      const blob = new Blob([Uint8Array.from(payload.data)], { type: payload.mime_type })
      setSpreadPage({ index: partnerIndex, url: URL.createObjectURL(blob) })
    } catch (error) {
      console.error('Failed to load spread page', { path, pageIndex: partnerIndex, error })
    }
  }, [pageCount])

  useEffect(() => {
    if (!spreadMode || !archivePath) {
      return
    }

    const partnerIndex = getSpreadPartnerIndex(pageIndex, pageCount)
    if (partnerIndex === null) {
      if (spreadPage) {
        setSpreadPage(null)
      }
      return
    }

    if (spreadPage?.index !== partnerIndex) {
      const offset = partnerIndex > pageIndex ? 1 : -1
      void openSpread(offset)
    }
  }, [archivePath, openSpread, pageCount, pageIndex, spreadMode, spreadPage])

  useEffect(() => {
    const handlePageNavigation = (event: KeyboardEvent) => {
      if (!archivePath || pageCount === 0 || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) {
        return
      }

      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"]'))) {
        return
      }

      let nextIndex: number
      switch (event.key) {
        case 'ArrowLeft':
          nextIndex = pageIndex - pageStep
          break
        case 'ArrowRight':
          nextIndex = pageIndex + pageStep
          break
        case 'ArrowUp':
          nextIndex = 0
          break
        case 'ArrowDown':
          nextIndex = pageCount - 1
          break
        default:
          return
      }

      if (nextIndex < 0 || nextIndex >= pageCount || nextIndex === pageIndex) {
        return
      }

      event.preventDefault()
      navigateToPage(archivePath, nextIndex)
    }

    window.addEventListener('keydown', handlePageNavigation)
    return () => window.removeEventListener('keydown', handlePageNavigation)
  }, [archivePath, navigateToPage, pageCount, pageIndex, pageStep])

  const handlePickArchive = async () => {
    await selectArchive()
  }

  const handleMenuSelect = async (id: (typeof MENU_ITEMS)[number]['id']) => {
    setIsMenuOpen(false)

    if (id === 'archive') {
      await handlePickArchive()
      return
    }

    if (id === 'bookmarks') {
      setIsBookmarksOpen(true)
      setBookmarkError('')
      if (archiveId) {
        try {
          const savedBookmarks = await invoke<Bookmark[]>('list_bookmarks', { archiveId })
          setBookmarks(savedBookmarks)
        } catch (error) {
          setBookmarkError('Unable to load bookmarks for this archive.')
          console.error('Failed to list bookmarks', { archiveId, error })
        }
      }
      return
    }

    if (id === 'settings') {
      setCacheModeDraft(cacheMode)
      setSpreadModeDraft(spreadMode)
      setPageTransitionDraft(pageTransition)
      setSettingsError('')
      setIsSettingsOpen(true)
      return
    }

    if (!archivePath || pageCount === 0) {
      return
    }

    setPageJumpInput(String(pageIndex + 1))
    setPageJumpError('')
    setIsPageJumpOpen(true)
  }

  const handleToggleCurrentBookmark = async () => {
    if (!archivePath || !archiveId || pageCount === 0 || isTogglingBookmark) {
      return
    }

    const targetPageIndex = pageIndex
    const targetArchiveId = archiveId
    const existingBookmark = bookmarks.find((bookmark) => bookmark.page_index === targetPageIndex)
    setIsTogglingBookmark(true)
    setBookmarkError('')

    try {
      if (existingBookmark) {
        await invoke('delete_bookmark', { bookmarkId: existingBookmark.id })
        if (archiveIdRef.current === targetArchiveId) {
          setBookmarks((current) => current.filter((bookmark) => bookmark.id !== existingBookmark.id))
        }
      } else {
        const bookmark = await invoke<Bookmark>('create_bookmark', {
          path: archivePath,
          pageIndex: targetPageIndex,
        })
        if (archiveIdRef.current === targetArchiveId) {
          setBookmarks((current) => [...current.filter((item) => item.page_index !== targetPageIndex), bookmark]
            .sort((left, right) => left.page_index - right.page_index))
        }
      }
    } catch (error) {
      setBookmarkError(existingBookmark ? 'Unable to remove this bookmark.' : 'Unable to add a bookmark.')
      console.error('Failed to toggle bookmark', {
        archivePath,
        pageIndex: targetPageIndex,
        error,
      })
    } finally {
      setIsTogglingBookmark(false)
    }
  }

  const handleSaveSettings = async () => {
    setIsSavingSettings(true)
    setSettingsError('')

    try {
      await invoke('save_settings', {
        settings: {
          cacheMode: cacheModeDraft,
          spreadMode: spreadModeDraft,
          pageTransition: pageTransitionDraft,
        } satisfies AppSettings,
      })
      cacheModeRef.current = cacheModeDraft
      setCacheMode(cacheModeDraft)
      setSpreadMode(spreadModeDraft)
      setPageTransition(pageTransitionDraft)
      setIsSettingsOpen(false)
      if (cacheModeDraft === 'nearby') {
        fullArchivePrefetchGenerationRef.current += 1
        fullArchivePrefetchPathRef.current = null
      } else if (archivePathRef.current && pageCount > 0) {
        prefetchAroundPage(archivePathRef.current, pageIndexRef.current)
      }
    } catch (error) {
      setSettingsError('Unable to save this setting.')
      console.error('Failed to save settings', error)
    } finally {
      setIsSavingSettings(false)
    }
  }

  const discardSettingsChanges = () => {
    setCacheModeDraft(cacheMode)
    setSpreadModeDraft(spreadMode)
    setPageTransitionDraft(pageTransition)
    setSettingsError('')
    setIsSettingsOpen(false)
  }

  const handlePageJumpSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const requestedPage = Number(pageJumpInput.trim())

    if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > pageCount) {
      setPageJumpError(`Enter a page number from 1 to ${pageCount}.`)
      return
    }

    const nextIndex = requestedPage - 1
    setPageJumpError('')
    setIsPageJumpOpen(false)
    if (archivePath) {
      navigateToPage(archivePath, nextIndex)
    }
  }

  return (
    <main className="min-h-screen w-full bg-slate-950 px-2 py-2 text-slate-100 xl:px-3">
      <div className="w-full">
        <div
          className="fixed inset-x-0 top-0 z-40 h-3"
          onMouseEnter={() => setIsHeaderHovered(true)}
        />
        <header
          onMouseEnter={() => setIsHeaderHovered(true)}
          onMouseLeave={() => setIsHeaderHovered(false)}
          className={`fixed inset-x-2 top-2 z-50 transition-transform duration-200 ease-out xl:inset-x-3 ${
            isHeaderHovered || isMenuOpen ? 'translate-y-0' : '-translate-y-[calc(100%+0.5rem)]'
          }`}
        >
          <div className="flex h-16 items-center justify-between rounded-2xl border border-slate-800 bg-slate-900/80 px-4 shadow-2xl shadow-black/20">
            <div className="flex items-center gap-3">
              <div className="dropdown dropdown-start">
                <button
                  type="button"
                  onClick={() => setIsMenuOpen((prev) => !prev)}
                  aria-label="Open menu"
                  className="btn btn-square btn-ghost border border-slate-700 bg-slate-900/80 text-slate-100 hover:bg-slate-800"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M4 7h16" />
                    <path d="M4 12h16" />
                    <path d="M4 17h16" />
                  </svg>
                </button>

                {isMenuOpen ? (
                  <ul className="menu dropdown-content z-[1] mt-3 w-52 rounded-box border border-slate-800 bg-slate-950 p-2 shadow-xl shadow-black/30">
                    {MENU_ITEMS.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => void handleMenuSelect(item.id)}
                          disabled={
                            (item.id === 'jump' && (!archivePath || pageCount === 0)) ||
                            (item.id === 'bookmarks' && !archiveId)
                          }
                          className="text-sm text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {item.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              <div>
                <p
                  className="max-w-[60vw] truncate text-sm font-semibold text-slate-100"
                  title={archivePath ?? 'Brave Comic Reader'}
                >
                  {archivePath?.split(/[\\/]/).pop() || 'Brave Comic Reader'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleToggleCurrentBookmark()}
                disabled={!archivePath || pageCount === 0 || !archiveId || isTogglingBookmark}
                aria-label={isCurrentPageBookmarked ? 'Remove bookmark from current page' : 'Bookmark current page'}
                aria-pressed={isCurrentPageBookmarked}
                title={isCurrentPageBookmarked ? 'Remove bookmark' : 'Bookmark this page'}
                className={`btn btn-square btn-ghost border border-slate-700 bg-slate-900/80 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 ${
                  isCurrentPageBookmarked ? 'text-amber-400' : 'text-slate-400'
                }`}
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
                  <path d="M6 3.75A1.75 1.75 0 0 1 7.75 2h8.5A1.75 1.75 0 0 1 18 3.75V22l-6-4-6 4V3.75Z" />
                </svg>
              </button>
            </div>
          </div>
        </header>
        {bookmarkError && !isBookmarksOpen ? (
          <div
            role="alert"
            className="fixed right-4 top-20 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-rose-800 bg-slate-950 px-4 py-3 text-sm text-rose-300 shadow-xl"
          >
            <span>{bookmarkError}</span>
            <button type="button" onClick={() => setBookmarkError('')} aria-label="Dismiss bookmark error" className="text-lg leading-none text-slate-400 hover:text-white">
              &times;
            </button>
          </div>
        ) : null}
        {archiveError && archivePath ? (
          <div
            role="alert"
            className="fixed right-4 top-20 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-rose-800 bg-slate-950 px-4 py-3 text-sm text-rose-300 shadow-xl"
          >
            <span>{archiveError}</span>
            <button type="button" onClick={() => setArchiveError('')} aria-label="Dismiss archive error" className="text-lg leading-none text-slate-400 hover:text-white">
              &times;
            </button>
          </div>
        ) : null}

        <div className="flex min-h-[calc(100vh-16px)] max-h-[calc(100vh-16px)] w-full gap-4">
          {isThumbnailPaneOpen ? (
            <aside className="flex w-[124px] shrink-0 flex-col rounded-2xl border border-slate-800 bg-slate-900/80 p-2.5 shadow-2xl shadow-black/20">
              <div className="flex shrink-0 items-center gap-1 px-1 pb-1 text-[10px] text-slate-400">
                <span className="min-w-0 flex-1 truncate text-center">{currentPageLabel}</span>
                <button
                  type="button"
                  onClick={() => setIsThumbnailPaneOpen(false)}
                  aria-label="Hide thumbnails"
                  title="Hide thumbnails"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m14 18-6-6 6-6" />
                    <path d="M20 4v16" />
                  </svg>
                </button>
              </div>

              <div className="flex min-h-0 w-full flex-1 gap-1.5">
              <div
                role="img"
                aria-label={`${cachedPageCount} of ${pageCount} pages cached`}
                title={`${cachedPageCount}/${pageCount} pages cached`}
                className="relative my-1 w-1.5 shrink-0 overflow-hidden rounded-full bg-slate-800/80"
              >
                {pageCount > 0 && cachedPageRanges.map((range) => (
                  <div
                    key={`${range.start}-${range.end}`}
                    className="pointer-events-none absolute inset-x-0 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.65)]"
                    style={{
                      top: `${(range.start / pageCount) * 100}%`,
                      height: `${((range.end - range.start) / pageCount) * 100}%`,
                    }}
                  />
                ))}
                {pageCount > 0 && thumbnailViewportRange.end > thumbnailViewportRange.start ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -left-1 -right-1 z-10 rounded border border-white/80 bg-white/10 shadow-[0_0_5px_rgba(255,255,255,0.35)]"
                    style={{
                      top: `${(thumbnailViewportRange.start / pageCount) * 100}%`,
                      height: `${((thumbnailViewportRange.end - thumbnailViewportRange.start) / pageCount) * 100}%`,
                    }}
                  />
                ) : null}
                {pageCount > 0 ? (
                  <div
                    className="pointer-events-none absolute -left-px z-10 w-2 rounded-full bg-white shadow-[0_0_5px_rgba(255,255,255,0.9)]"
                    style={{
                      top: `${(pageIndex / pageCount) * 100}%`,
                      height: `${Math.max(100 / pageCount, 0.25)}%`,
                    }}
                  />
                ) : null}
              </div>

              <div
                ref={thumbnailsContainerRef}
                className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden rounded-xl border border-slate-800 bg-slate-950/70 px-1 py-1 scrollbar-thin"
              >
                {pageNames.length === 0 ? (
                  <p className="text-xs text-slate-500">No pages loaded yet.</p>
                ) : (
                  <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%', margin: 0, padding: 0 }}>
                    {virtualizer.getVirtualItems().map((virtualItem) => {
                      const index = virtualItem.index
                      const name = pageNames[index]

                      return (
                        <div
                          key={virtualItem.key}
                          data-index={index}
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            display: 'flex',
                            justifyContent: 'center',
                            padding: '0 0 0 0',
                            margin: 0,
                            transform: `translateY(${virtualItem.start}px)`,
                          }}
                        >
                          <ThumbnailItem
                            index={index}
                            name={name}
                            pageThumbnail={pageThumbnails[index] ?? ''}
                            pageLoaded={pageLoaded[index] ?? false}
                            isActive={pageIndex === index}
                            isBookmarked={bookmarkedPageIndices.has(index)}
                            onSelect={(nextIndex) => {
                              navigateToPage(archivePath ?? '', nextIndex)
                            }}
                          />
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
              </div>
            </aside>
          ) : (
            <button
              type="button"
              onClick={() => setIsThumbnailPaneOpen(true)}
              aria-label="Show thumbnails"
              title="Show thumbnails"
              className="flex w-8 shrink-0 items-start justify-center rounded-2xl border border-slate-800 bg-slate-900/80 pt-3 text-slate-400 shadow-2xl shadow-black/20 hover:bg-slate-800 hover:text-slate-100"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m10 18 6-6-6-6" />
                <path d="M4 4v16" />
              </svg>
            </button>
          )}

          <section ref={viewerSectionRef} className={`relative flex h-[calc(100vh-16px)] min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-slate-900/80 p-4 shadow-2xl shadow-black/20 ${isArchiveDragOver ? 'border-cyan-400' : 'border-slate-800'}`}>
            {archivePath ? (
              <ComicViewerCarousel
                pageCount={pageCount}
                pageIndex={pageIndex}
                pageStep={pageStep}
                spreadMode={spreadMode}
                pageTransition={pageTransition}
                pageNames={pageNames}
                imageUrl={imageUrl}
                archivePath={archivePath}
                spreadPage={spreadPage}
                onSpread={(offset) => void openSpread(offset)}
                onPageChange={(nextIndex) => {
                  if (!archivePath || nextIndex < 0 || nextIndex >= pageCount || nextIndex === pageIndex) {
                    return
                  }
                  navigateToPage(archivePath, nextIndex)
                }}
              />
            ) : (
              <div className={`flex h-full min-h-0 flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 text-center transition-colors ${isArchiveDragOver ? 'border-cyan-400 bg-cyan-950/30' : 'border-slate-700 bg-slate-950/30'}`}>
                <svg viewBox="0 0 24 24" className={`mb-5 h-14 w-14 ${isArchiveDragOver ? 'text-cyan-300' : 'text-slate-500'}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 16V4" />
                  <path d="m7 9 5-5 5 5" />
                  <path d="M20 16.5v2A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-2" />
                </svg>
                <h1 className="text-xl font-semibold text-slate-100">
                  {isArchiveDragOver ? 'Drop to open archive' : 'Open a comic archive'}
                </h1>
                <p className="mt-2 max-w-md text-sm leading-6 text-slate-400">
                  Drag and drop a PDF or archive file here, or choose <span className="text-slate-200">Open archive</span> from the menu.
                </p>
                <p className="mt-3 text-xs text-slate-500">PDF, ZIP / CBZ, 7Z / CB7, RAR / CBR, TAR and compressed TAR</p>
                {archiveError ? (
                  <p role="alert" className="mt-5 rounded-lg border border-rose-800 bg-rose-950/40 px-4 py-2 text-sm text-rose-300">
                    {archiveError}
                  </p>
                ) : null}
              </div>
            )}
            {isArchiveDragOver && archivePath ? (
              <div className="pointer-events-none absolute inset-4 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-cyan-400 bg-slate-950/80 text-lg font-semibold text-cyan-200">
                Drop to open archive
              </div>
            ) : null}
          </section>
        </div>
      </div>

      {isPageJumpOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsPageJumpOpen(false)
              setPageJumpError('')
            }
          }}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="page-jump-title"
            onSubmit={handlePageJumpSubmit}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setIsPageJumpOpen(false)
                setPageJumpError('')
              }
            }}
            className="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
          >
            <h2 id="page-jump-title" className="text-base font-semibold text-slate-100">Jump to page</h2>
            <p className="mt-1 text-sm text-slate-400">Enter a page number from 1 to {pageCount}.</p>
            <label htmlFor="page-jump-input" className="mt-4 block text-sm text-slate-200">Page number</label>
            <input
              id="page-jump-input"
              type="number"
              min={1}
              max={pageCount}
              step={1}
              autoFocus
              value={pageJumpInput}
              onChange={(event) => {
                setPageJumpInput(event.target.value)
                setPageJumpError('')
              }}
              className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-cyan-500"
            />
            {pageJumpError ? <p role="alert" className="mt-2 text-sm text-rose-400">{pageJumpError}</p> : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsPageJumpOpen(false)
                  setPageJumpError('')
                }}
                className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button type="submit" className="rounded-lg bg-cyan-700 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-600">
                Go
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {isBookmarksOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsBookmarksOpen(false)
              setBookmarkError('')
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="bookmarks-title"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setIsBookmarksOpen(false)
                setBookmarkError('')
              }
            }}
            className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="bookmarks-title" className="text-base font-semibold text-slate-100">Bookmarks</h2>
                <p className="mt-1 truncate text-sm text-slate-400">{archivePath?.split(/[\\/]/).pop()}</p>
              </div>
              <button
                type="button"
                aria-label="Close bookmarks"
                onClick={() => {
                  setIsBookmarksOpen(false)
                  setBookmarkError('')
                }}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-xl leading-none text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              >
                &times;
              </button>
            </div>
            {bookmarkError ? <p role="alert" className="mt-3 text-sm text-rose-400">{bookmarkError}</p> : null}
            {bookmarks.length === 0 ? (
              <p className="mt-5 text-sm text-slate-400">No bookmarks in this archive.</p>
            ) : (
              <ul className="mt-4 max-h-[60vh] space-y-2 overflow-y-auto">
                {bookmarks.map((bookmark) => (
                  <li key={bookmark.id} className="flex items-center gap-2 rounded-lg border border-slate-700 p-2">
                    <button
                      type="button"
                      onClick={() => {
                        const matchingPage = pageNames.indexOf(bookmark.page_name)
                        const targetIndex = matchingPage >= 0 ? matchingPage : bookmark.page_index
                        if (archivePath && targetIndex >= 0 && targetIndex < pageCount) {
                          setIsBookmarksOpen(false)
                          navigateToPage(archivePath, targetIndex)
                        } else {
                          setBookmarkError('The bookmarked page is no longer available.')
                        }
                      }}
                      className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-sm text-slate-100 hover:bg-slate-800"
                    >
                      <span className="mr-2 text-cyan-400">Page {bookmark.page_index + 1}</span>
                      <span className="text-slate-300">{bookmark.page_name}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete bookmark for page ${bookmark.page_index + 1}`}
                      onClick={() => {
                        void invoke('delete_bookmark', { bookmarkId: bookmark.id })
                          .then(() => setBookmarks((existing) => existing.filter((item) => item.id !== bookmark.id)))
                          .catch((error: unknown) => {
                            setBookmarkError('Unable to delete this bookmark.')
                            console.error('Failed to delete bookmark', { bookmarkId: bookmark.id, error })
                          })
                      }}
                      className="inline-flex size-8 shrink-0 items-center justify-center rounded text-rose-300 hover:bg-rose-950/60"
                    >
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4 7h16" />
                        <path d="M10 11v6M14 11v6" />
                        <path d="m5 7 1 14h12l1-14" />
                        <path d="M9 7V4h6v3" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}

      {isSettingsOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              discardSettingsChanges()
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                discardSettingsChanges()
              }
            }}
            className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="settings-title" className="text-base font-semibold text-slate-100">Settings</h2>
                <p className="mt-1 text-sm text-slate-400">Choose page caching and display behavior.</p>
              </div>
              <button
                type="button"
                aria-label="Close settings"
                onClick={discardSettingsChanges}
                disabled={isSavingSettings}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-xl leading-none text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              >
                &times;
              </button>
            </div>

            <fieldset className="mt-5 space-y-3">
              <legend className="mb-2 text-sm font-medium text-slate-200">Page cache</legend>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-700 p-3 hover:border-slate-500">
                <input
                  type="radio"
                  name="cache-mode"
                  value="nearby"
                  checked={cacheModeDraft === 'nearby'}
                  onChange={() => setCacheModeDraft('nearby')}
                  className="radio radio-info mt-0.5"
                />
                <span>
                  <span className="block text-sm font-medium text-slate-100">Nearby pages only</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-slate-400">Cache pages around the current page to keep memory usage low.</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-700 p-3 hover:border-slate-500">
                <input
                  type="radio"
                  name="cache-mode"
                  value="fullArchive"
                  checked={cacheModeDraft === 'fullArchive'}
                  onChange={() => setCacheModeDraft('fullArchive')}
                  className="radio radio-info mt-0.5"
                />
                <span>
                  <span className="block text-sm font-medium text-slate-100">Cache the entire archive</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-slate-400">Cache nearby pages first, then process the remaining pages in the background for faster navigation. Uses more memory.</span>
                </span>
              </label>
            </fieldset>

            <fieldset className="mt-5 space-y-3">
              <legend className="mb-2 text-sm font-medium text-slate-200">Page display</legend>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-700 p-3 hover:border-slate-500">
                <input
                  type="radio"
                  name="spread-mode"
                  value="single"
                  checked={!spreadModeDraft}
                  onChange={() => setSpreadModeDraft(false)}
                  className="radio radio-info mt-0.5"
                />
                <span>
                  <span className="block text-sm font-medium text-slate-100">Single page</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-slate-400">Display one page at a time.</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-700 p-3 hover:border-slate-500">
                <input
                  type="radio"
                  name="spread-mode"
                  value="spread"
                  checked={spreadModeDraft}
                  onChange={() => setSpreadModeDraft(true)}
                  className="radio radio-info mt-0.5"
                />
                <span>
                  <span className="block text-sm font-medium text-slate-100">Spread pages</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-slate-400">Keep the current page and an adjacent page displayed together, including after navigation.</span>
                </span>
              </label>
            </fieldset>

            <fieldset className="mt-5 space-y-3">
              <legend className="mb-2 text-sm font-medium text-slate-200">Page transition</legend>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-700 p-3 hover:border-slate-500">
                <input
                  type="radio"
                  name="page-transition"
                  value="cut"
                  checked={pageTransitionDraft === 'cut'}
                  onChange={() => setPageTransitionDraft('cut')}
                  className="radio radio-info mt-0.5"
                />
                <span>
                  <span className="block text-sm font-medium text-slate-100">Cut</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-slate-400">Replace the current page directly without fading through a blank screen.</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-700 p-3 hover:border-slate-500">
                <input
                  type="radio"
                  name="page-transition"
                  value="crossDissolve"
                  checked={pageTransitionDraft === 'crossDissolve'}
                  onChange={() => setPageTransitionDraft('crossDissolve')}
                  className="radio radio-info mt-0.5"
                />
                <span>
                  <span className="block text-sm font-medium text-slate-100">Cross dissolve</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-slate-400">Blend the current page into the next page over 500ms.</span>
                </span>
              </label>
            </fieldset>

            {settingsError ? <p role="alert" className="mt-3 text-sm text-rose-400">{settingsError}</p> : null}
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={discardSettingsChanges}
                disabled={isSavingSettings}
                className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSaveSettings()}
                disabled={isSavingSettings}
                className="ml-2 rounded-lg bg-cyan-700 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:cursor-wait disabled:opacity-60"
              >
                Done
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  )
}

export default App
