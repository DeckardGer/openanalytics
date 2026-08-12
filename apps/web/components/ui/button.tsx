"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

export const buttonVariants = cva(
 "inline-flex items-center justify-center gap-1 whitespace-nowrap cursor-pointer rounded-full! text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive cursor-pointer",
  {
    variants: {
      variant: {
        default: "border border-[color-mix(in_srgb,var(--primary)_80%,#3a3480)] bg-[color-mix(in_srgb,var(--primary)_90%,#3a3480)] text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.22),inset_0_-1px_0_rgba(58,52,128,0.30)] transform-gpu hover:bg-primary hover:border-[color-mix(in_srgb,var(--primary)_70%,#3a3480)] active:translate-y-px active:scale-[0.98] active:bg-[color-mix(in_srgb,var(--primary)_90%,#3a3480)] active:shadow-[inset_0_1px_0_rgba(255,255,255,0.14),inset_0_-1px_0_rgba(58,52,128,0.26)]",
        destructive:
          "bg-destructive text-white transform-gpu hover:bg-destructive/90 focus-visible:ring-destructive/20 active:translate-y-px active:scale-[0.98] dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
         outline:
        "border border-transparent bg-[#26262a] text-primary-foreground transform-gpu hover:bg-[#3a3a3f] active:translate-y-px active:scale-[0.98]",
        secondary:
                  "border border-transparent bg-secondary text-secondary-foreground transform-gpu hover:bg-[color-mix(in_srgb,var(--secondary)_95%,var(--ink))] active:translate-y-px active:scale-[0.98]",
  
        ghost:
          "text-muted-foreground hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 rounded-lg px-3 py-1.5 has-[>svg]:px-3 text-sm",
        xs: "h-7 rounded-lg px-2 has-[>svg]:px-2 text-xs",
        sm: "h-8 rounded-lg gap-1.5 px-3 has-[>svg]:px-2.5",
        md: "h-9 rounded-lg px-3 py-1.5 has-[>svg]:px-3 text-sm",
        lg: "h-10 rounded-lg px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  render,
  children,
  loading = false,
  disabled: disabledProp,
  ...props
}: ButtonProps): React.ReactElement {
  const isDisabled: boolean = Boolean(loading || disabledProp);
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] =
    render ? undefined : "button";

  const defaultProps = {
    children: (
      <>
        {loading && (
          <Spinner
            className="pointer-events-none size-3.5"
            data-slot="button-loading-indicator"
          />
        )}
        {children}
      </>
    ),
    className: cn(buttonVariants({ className, size, variant })),
    "aria-disabled": loading || undefined,
    "data-loading": loading ? "" : undefined,
    "data-slot": "button",
    disabled: isDisabled,
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}
