import * as React from "react"

/** Matches Tailwind's `lg` breakpoint, so this hook and the `lg:` / `max-lg:` classes always agree. */
const MOBILE_BREAKPOINT = 1024
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

/**
 * True below the `lg` breakpoint. It reads the media query's own result rather than `window.innerWidth`:
 * on iOS, pinch zoom shrinks `innerWidth` (the visual viewport) while media queries keep using the layout
 * viewport, and the two disagreeing put a phone-mode thread inside a desktop-mode grid.
 */
export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(QUERY)
    const onChange = () => {
      setIsMobile(mql.matches)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(mql.matches)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
