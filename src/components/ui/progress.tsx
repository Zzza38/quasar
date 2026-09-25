"use client"

import * as React from "react"
import { cn } from "cn"
import { Progress as ProgressPrimitive } from "radix-ui"

// Radix only reports a determinate progressbar (aria-valuenow, data-state) when
// Root receives `value`, and it logs an error for values outside 0..max, so
// clamp here and forward the same number to both Root and the indicator.
export function clampProgress(value: number | null | undefined, max = 100): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return Math.min(max, Math.max(0, value))
}

function Progress({
  className,
  value,
  max = 100,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const safeMax = typeof max === "number" && Number.isFinite(max) && max > 0 ? max : 100
  const clamped = clampProgress(value, safeMax)
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted",
        className
      )}
      value={clamped}
      max={safeMax}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="size-full flex-1 bg-primary transition-all"
        style={{ transform: `translateX(-${100 - ((clamped ?? 0) / safeMax) * 100}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
