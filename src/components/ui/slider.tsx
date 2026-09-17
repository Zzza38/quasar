'use client';

import { Slider as SliderPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Slider({ className, trackClassName, ...props }: ComponentProps<typeof SliderPrimitive.Root> & { trackClassName?: string }) {
  return <SliderPrimitive.Root data-slot="slider" className={cn('relative flex h-5 w-full touch-none select-none items-center data-disabled:opacity-50', className)} {...props}>
    <SliderPrimitive.Track className={cn('relative h-2 w-full grow overflow-hidden rounded-full bg-muted', trackClassName)}>
      <SliderPrimitive.Range className="absolute h-full bg-transparent" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb aria-label={props['aria-label']} className="block size-4 rounded-full border-2 border-white bg-transparent shadow-[0_0_0_1px_#0005] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none" />
  </SliderPrimitive.Root>;
}
