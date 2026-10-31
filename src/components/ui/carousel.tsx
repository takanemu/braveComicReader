import useEmblaCarousel, { type UseEmblaCarouselType } from 'embla-carousel-react'
import { type EmblaCarouselType, type EmblaOptionsType } from 'embla-carousel'
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useMemo,
  type HTMLAttributes,
  type ReactNode,
} from 'react'

type CarouselApi = UseEmblaCarouselType[1]
type CarouselOptions = EmblaOptionsType

type CarouselContextValue = {
  carouselRef: (node: HTMLElement | null) => void
  api: CarouselApi
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

  useEffect(() => {
    if (!api) {
      return
    }

    if (setApi) {
      setApi(api)
    }
  }, [api, setApi])

  const value = useMemo(
    () => ({
      carouselRef,
      api,
    }),
    [api, carouselRef],
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

export {
  Carousel,
  CarouselContent,
  CarouselItem,
  type CarouselApi,
}
