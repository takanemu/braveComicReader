import useEmblaCarousel, { type UseEmblaCarouselType } from 'embla-carousel-react'
import { type EmblaCarouselType, type EmblaOptionsType } from 'embla-carousel'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react'

type CarouselApi = UseEmblaCarouselType[1]
type CarouselOptions = EmblaOptionsType

type CarouselContextValue = {
  carouselRef: (node: HTMLElement | null) => void
  api: CarouselApi
  canScrollPrev: boolean
  canScrollNext: boolean
  scrollPrev: () => void
  scrollNext: () => void
}

const CarouselContext = createContext<CarouselContextValue | null>(null)

function useCarousel() {
  const context = useContext(CarouselContext)
  if (!context) {
    throw new Error('useCarousel must be used within Carousel')
  }
  return context
}

type CarouselProps = {
  opts?: CarouselOptions
  setApi?: (api: EmblaCarouselType) => void
  className?: string
  children: ReactNode
}

const Carousel = ({ opts, setApi, className, children }: CarouselProps) => {
  const [carouselRef, api] = useEmblaCarousel(opts)
  const [canScrollPrev, setCanScrollPrev] = useState(false)
  const [canScrollNext, setCanScrollNext] = useState(false)

  const onSelect = useCallback((emblaApi: EmblaCarouselType) => {
    setCanScrollPrev(emblaApi.canScrollPrev())
    setCanScrollNext(emblaApi.canScrollNext())
  }, [])

  const scrollPrev = useCallback(() => {
    api?.scrollPrev()
  }, [api])

  const scrollNext = useCallback(() => {
    api?.scrollNext()
  }, [api])

  useEffect(() => {
    if (!api) {
      return
    }

    onSelect(api)
    api.on('reInit', onSelect)
    api.on('select', onSelect)

    if (setApi) {
      setApi(api)
    }

    return () => {
      api.off('reInit', onSelect)
      api.off('select', onSelect)
    }
  }, [api, onSelect, setApi])

  const value = useMemo(
    () => ({
      carouselRef,
      api,
      canScrollPrev,
      canScrollNext,
      scrollPrev,
      scrollNext,
    }),
    [api, canScrollNext, canScrollPrev, scrollNext, scrollPrev, carouselRef],
  )

  return (
    <CarouselContext.Provider value={value}>
      <div className={`${className ?? ''} h-full min-h-0`}>{children}</div>
    </CarouselContext.Provider>
  )
}

const CarouselContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => {
  const { carouselRef } = useCarousel()

  return (
    <div ref={carouselRef} className="h-full overflow-hidden">
      <div ref={ref} className={`flex h-full touch-pan-y ${className ?? ''}`} {...props} />
    </div>
  )
})
CarouselContent.displayName = 'CarouselContent'

const CarouselItem = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => {
  return <div ref={ref} role="group" aria-roledescription="slide" className={`h-full min-h-0 min-w-0 shrink-0 grow-0 basis-full ${className ?? ''}`} {...props} />
})
CarouselItem.displayName = 'CarouselItem'

type CarouselButtonProps = {
  className?: string
}

const buttonBaseClassName =
  'inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 bg-slate-950/80 text-slate-100 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50'

const CarouselPrevious = ({ className }: CarouselButtonProps) => {
  const { canScrollPrev, scrollPrev } = useCarousel()

  return (
    <button type="button" onClick={scrollPrev} disabled={!canScrollPrev} className={`${buttonBaseClassName} ${className ?? ''}`} aria-label="Previous slide">
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 18l-6-6 6-6" />
      </svg>
    </button>
  )
}

const CarouselNext = ({ className }: CarouselButtonProps) => {
  const { canScrollNext, scrollNext } = useCarousel()

  return (
    <button type="button" onClick={scrollNext} disabled={!canScrollNext} className={`${buttonBaseClassName} ${className ?? ''}`} aria-label="Next slide">
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18l6-6-6-6" />
      </svg>
    </button>
  )
}

export {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
}
