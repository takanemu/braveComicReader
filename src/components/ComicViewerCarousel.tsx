import { useEffect, useMemo, useRef, useState, type FC } from 'react'
import { type EmblaCarouselType } from 'embla-carousel'
import {
  Carousel,
  CarouselContent,
  CarouselItem,
} from './ui/carousel'

type ComicViewerCarouselProps = {
  pageCount: number
  pageIndex: number
  pageStep: 1 | 2
  spreadMode: boolean
  pageTransition: 'cut' | 'crossDissolve'
  pageNames: string[]
  imageUrl: string | null
  archivePath: string | null
  spreadPage: { index: number; url: string } | null
  onSpread: (offset: -1 | 1) => void
  onPageChange: (nextIndex: number) => void
}

type DisplayedPage = {
  pageIndex: number
  imageUrl: string | null
  spreadPage: { index: number; url: string } | null
  spreadMode: boolean
}

const ComicViewerCarousel: FC<ComicViewerCarouselProps> = ({
  pageCount,
  pageIndex,
  pageStep,
  spreadMode,
  pageTransition,
  pageNames,
  imageUrl,
  archivePath,
  spreadPage,
  onSpread,
  onPageChange,
}) => {
  const [api, setApi] = useState<EmblaCarouselType | null>(null)
  const [navigationVisible, setNavigationVisible] = useState(false)
  const navigationIdleTimerRef = useRef<number | null>(null)
  const navigationHoveredRef = useRef(false)
  const [displayedPage, setDisplayedPage] = useState<DisplayedPage>(() => ({
    pageIndex,
    imageUrl,
    spreadPage,
    spreadMode,
  }))
  const renderRadius = 2
  const isPageTransitioning =
    displayedPage.pageIndex !== pageIndex ||
    displayedPage.imageUrl !== imageUrl ||
    displayedPage.spreadPage?.index !== spreadPage?.index ||
    displayedPage.spreadPage?.url !== spreadPage?.url ||
    displayedPage.spreadMode !== spreadMode

  useEffect(() => {
    if (pageTransition === 'cut') {
      if (isPageTransitioning) {
        setDisplayedPage({ pageIndex, imageUrl, spreadPage, spreadMode })
      }
      return
    }

    if (!isPageTransitioning) {
      return
    }

    const transitionTimer = window.setTimeout(() => {
      setDisplayedPage({ pageIndex, imageUrl, spreadPage, spreadMode })
    }, 500)

    return () => {
      window.clearTimeout(transitionTimer)
    }
  }, [imageUrl, isPageTransitioning, pageIndex, pageTransition, spreadMode, spreadPage])

  const revealNavigation = () => {
    setNavigationVisible(true)
    if (navigationIdleTimerRef.current !== null) {
      window.clearTimeout(navigationIdleTimerRef.current)
    }
    if (navigationHoveredRef.current) {
      navigationIdleTimerRef.current = null
      return
    }
    navigationIdleTimerRef.current = window.setTimeout(() => {
      navigationIdleTimerRef.current = null
      setNavigationVisible(false)
    }, 3000)
  }

  const buttonHoverHandlers = {
    onMouseEnter: () => {
      navigationHoveredRef.current = true
      revealNavigation()
    },
    onMouseLeave: () => {
      navigationHoveredRef.current = false
      revealNavigation()
    },
  }

  const hideNavigation = () => {
    navigationHoveredRef.current = false
    if (navigationIdleTimerRef.current !== null) {
      window.clearTimeout(navigationIdleTimerRef.current)
      navigationIdleTimerRef.current = null
    }
    setNavigationVisible(false)
  }

  useEffect(() => {
    return () => {
      if (navigationIdleTimerRef.current !== null) {
        window.clearTimeout(navigationIdleTimerRef.current)
      }
    }
  }, [])

  const renderedPageIndices = useMemo(() => {
    if (pageCount <= 0) {
      return [0]
    }

    const start = Math.max(0, pageIndex - renderRadius)
    const end = Math.min(pageCount, pageIndex + renderRadius + 1)
    return Array.from({ length: end - start }, (_, offset) => start + offset)
  }, [pageCount, pageIndex])

  const selectedSlideIndex = useMemo(() => {
    if (pageCount <= 0) {
      return 0
    }
    return renderedPageIndices.indexOf(pageIndex)
  }, [pageCount, pageIndex, renderedPageIndices])

  useEffect(() => {
    if (!api) {
      return
    }

    const selectedIndex = api.selectedScrollSnap()
    if (selectedIndex !== selectedSlideIndex) {
      api.scrollTo(Math.max(0, selectedSlideIndex), true)
    }
  }, [api, selectedSlideIndex])

  useEffect(() => {
    if (!api || !archivePath) {
      return
    }

    const handleSelect = () => {
      const selectedIndex = api.selectedScrollSnap()
      const direction = Math.sign(selectedIndex - selectedSlideIndex)
      if (direction !== 0) {
        const nextIndex = pageIndex + direction * pageStep
        if (nextIndex >= 0 && nextIndex < pageCount) {
          onPageChange(nextIndex)
        } else {
          api.scrollTo(selectedSlideIndex, true)
        }
      }
    }

    api.on('select', handleSelect)
    return () => {
      api.off('select', handleSelect)
    }
  }, [api, archivePath, onPageChange, pageCount, pageIndex, pageStep, selectedSlideIndex])

  const hasPage = pageCount > 0 && imageUrl
  const isPrevDisabled = !archivePath || pageIndex - pageStep < 0
  const isNextDisabled = !archivePath || pageIndex + pageStep >= pageCount
  const isPrevSpreadDisabled = !archivePath || pageIndex === 0
  const isNextSpreadDisabled = !archivePath || pageIndex >= pageCount - 1
  const spreadLayout = spreadMode || spreadPage !== null
  const shouldCrossDissolve = pageTransition === 'crossDissolve' && isPageTransitioning

  const renderPageImages = (
    renderedPageIndex: number,
    renderedImageUrl: string,
    renderedSpreadPage: DisplayedPage['spreadPage'],
    renderedSpreadMode: boolean,
  ) => {
    const isSpreadLayout = renderedSpreadMode || renderedSpreadPage !== null
    const isUnpaired = renderedSpreadMode && renderedSpreadPage === null && renderedPageIndex % 2 === 0

    return (
      <div className={`flex h-full w-full items-center ${isUnpaired ? 'justify-start' : 'justify-center'}`}>
        {renderedSpreadPage && renderedSpreadPage.index < renderedPageIndex ? (
          <img
            src={renderedSpreadPage.url}
            alt={pageNames[renderedSpreadPage.index] ?? 'Comic page'}
            className="h-full w-auto max-w-[50%] flex-none object-contain"
          />
        ) : null}
        <img
          src={renderedImageUrl}
          alt={pageNames[renderedPageIndex] ?? 'Comic page'}
          className={isSpreadLayout ? 'h-full w-auto max-w-[50%] flex-none object-contain' : 'h-full w-full object-contain'}
        />
        {renderedSpreadPage && renderedSpreadPage.index > renderedPageIndex ? (
          <img
            src={renderedSpreadPage.url}
            alt={pageNames[renderedSpreadPage.index] ?? 'Comic page'}
            className="h-full w-auto max-w-[50%] flex-none object-contain"
          />
        ) : null}
      </div>
    )
  }

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col"
      onMouseEnter={revealNavigation}
      onMouseMove={revealNavigation}
      onMouseLeave={hideNavigation}
    >
      <Carousel
        setApi={(emblaApi) => {
          setApi(emblaApi)
        }}
        opts={{ loop: false, dragFree: false }}
        className="h-full min-h-0 w-full flex-1"
      >
        <CarouselContent className="h-full min-h-0 w-full">
          {renderedPageIndices.map((renderedPageIndex) => (
            <CarouselItem key={renderedPageIndex} className="h-full min-h-0">
              <div className={`flex h-full min-h-0 items-center justify-center overflow-hidden rounded-xl border border-slate-800 bg-slate-950/60 ${spreadLayout ? 'p-0' : 'p-3'}`}>
                {hasPage && renderedPageIndex === pageIndex ? (
                  <div className="relative h-full w-full">
                    {shouldCrossDissolve && displayedPage.imageUrl ? (
                      <div
                        aria-hidden="true"
                        className="comic-page-layer comic-page-fade-out absolute inset-0"
                      >
                        {renderPageImages(
                          displayedPage.pageIndex,
                          displayedPage.imageUrl,
                          displayedPage.spreadPage,
                          displayedPage.spreadMode,
                        )}
                      </div>
                    ) : null}
                    <div className={`comic-page-layer relative ${shouldCrossDissolve ? 'comic-page-fade-in' : ''}`}>
                      {renderPageImages(pageIndex, imageUrl, spreadPage, spreadMode)}
                    </div>
                  </div>
                ) : pageCount === 0 ? (
                  <p className="text-sm text-slate-500">Choose an archive to render its first page here.</p>
                ) : (
                  <p className="text-sm text-slate-500">Loading page {renderedPageIndex + 1}...</p>
                )}
              </div>
            </CarouselItem>
          ))}
        </CarouselContent>
      </Carousel>

      <button
        type="button"
        aria-label="Previous page"
        title="Previous page"
        tabIndex={navigationVisible ? 0 : -1}
        {...buttonHoverHandlers}
        onClick={() => onPageChange(pageIndex - pageStep)}
        disabled={isPrevDisabled}
        className={`absolute left-5 top-1/2 z-20 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-slate-950/60 text-3xl leading-none text-white shadow-lg backdrop-blur-sm transition-opacity duration-500 ease-in-out hover:bg-slate-950/80 disabled:cursor-not-allowed disabled:opacity-40 ${navigationVisible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
      >
        &larr;
      </button>
      <button
        type="button"
        aria-label="Next page"
        title="Next page"
        tabIndex={navigationVisible ? 0 : -1}
        {...buttonHoverHandlers}
        onClick={() => onPageChange(pageIndex + pageStep)}
        disabled={isNextDisabled}
        className={`absolute right-5 top-1/2 z-20 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-slate-950/60 text-3xl leading-none text-white shadow-lg backdrop-blur-sm transition-opacity duration-500 ease-in-out hover:bg-slate-950/80 disabled:cursor-not-allowed disabled:opacity-40 ${navigationVisible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
      >
        &rarr;
      </button>
      <button
        type="button"
        aria-label="Spread with previous page"
        title="Spread with previous page"
        tabIndex={navigationVisible ? 0 : -1}
        {...buttonHoverHandlers}
        onClick={() => onSpread(-1)}
        disabled={!hasPage || isPrevSpreadDisabled}
        className={`absolute left-5 top-5 z-20 inline-flex size-11 items-center justify-center rounded-full bg-slate-950/60 text-white shadow-lg backdrop-blur-sm transition-opacity duration-500 ease-in-out hover:bg-slate-950/80 disabled:cursor-not-allowed disabled:opacity-40 ${navigationVisible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
      >
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="8" height="14" rx="1" />
          <rect x="13" y="5" width="8" height="14" rx="1" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Spread with next page"
        title="Spread with next page"
        tabIndex={navigationVisible ? 0 : -1}
        {...buttonHoverHandlers}
        onClick={() => onSpread(1)}
        disabled={!hasPage || isNextSpreadDisabled}
        className={`absolute right-5 top-5 z-20 inline-flex size-11 items-center justify-center rounded-full bg-slate-950/60 text-white shadow-lg backdrop-blur-sm transition-opacity duration-500 ease-in-out hover:bg-slate-950/80 disabled:cursor-not-allowed disabled:opacity-40 ${navigationVisible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
      >
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="8" height="14" rx="1" />
          <rect x="13" y="5" width="8" height="14" rx="1" />
        </svg>
      </button>
    </div>
  )
}

export default ComicViewerCarousel
