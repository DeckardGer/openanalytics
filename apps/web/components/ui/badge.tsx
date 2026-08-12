"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type React from "react";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleFadingArrowUpIcon,
  InfoIcon,
} from "@/components/icons/hugeicons";
import { cn } from "@/lib/utils";

/**
 * The badge, in the atlas project's language (adopted 2026-08-09): a flat
 * pill on the page's own background, whose hairline border is mixed from the
 * text colour itself — so every variant carries exactly one hue and the
 * frame follows it for free — and, on the informative variants, a leading
 * icon sitting in a small tinted disc.
 *
 * Not a 1:1 copy, deliberately: the icons are ours (the hugeicons set the
 * dashboard already speaks), the sizes are ours (atlas badges are denser
 * than this dashboard's rhythm), and there is no auto-icon-from-label
 * guessing — the *variant* names the meaning here, so the variant picks the
 * icon. Label-only variants (`secondary`, `outline` — roles, scopes,
 * surface names) stay icon-less; pass `icon` to add one, or `icon={null}`
 * to silence a default.
 */

export const badgeVariants = cva(
  // One hue per variant: the text sets it, the border borrows it at 34%,
  // the icon disc at 12% — the atlas mechanic, kept because it means a new
  // variant is one text-colour line, never three matched ones.
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full border border-[color-mix(in_srgb,currentColor_34%,transparent)] bg-background font-medium outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default:
          "h-7 min-w-7 px-3 text-sm sm:h-6 sm:min-w-6 sm:px-2.5 sm:text-xs",
        lg: "h-8 min-w-8 px-3.5 text-base sm:h-7 sm:min-w-7 sm:px-3 sm:text-sm",
        sm: "h-6 min-w-6 px-2.5 text-xs sm:h-5 sm:min-w-5 sm:px-2 sm:text-[.625rem]",
      },
      variant: {
        default: "text-blue-700 dark:text-blue-400",
        destructive: "text-red-700 dark:text-red-400",
        error: "text-red-700 dark:text-red-400",
        info: "text-blue-700 dark:text-blue-400",
        outline: "text-foreground",
        progress: "text-purple-700 dark:text-purple-400",
        secondary: "text-secondary-foreground",
        success: "text-emerald-700 dark:text-emerald-400",
        warning: "text-orange-700 dark:text-orange-400",
      },
    },
  },
);

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;
type BadgeSize = NonNullable<VariantProps<typeof badgeVariants>["size"]>;

/**
 * The informative variants' own icons. `secondary` and `outline` are
 * deliberately absent: they label things (a role, a scope, a surface), and a
 * label is not a state.
 */
const VARIANT_ICON: Partial<Record<BadgeVariant, React.ReactNode>> = {
  default: <InfoIcon />,
  destructive: <CircleAlertIcon />,
  error: <CircleAlertIcon />,
  info: <InfoIcon />,
  progress: <CircleFadingArrowUpIcon />,
  success: <CircleCheckIcon />,
  warning: <CircleAlertIcon />,
};

/** The tinted disc the icon sits in, sized to its badge. */
const ICON_DISC: Record<BadgeSize, string> = {
  default: "size-4.5 [&_svg]:size-3 sm:size-4 sm:[&_svg]:size-2.5",
  lg: "size-5.5 [&_svg]:size-3.5 sm:size-4.5 sm:[&_svg]:size-3",
  sm: "size-4 [&_svg]:size-2.5 sm:size-3.5 sm:[&_svg]:size-2.5",
};

/** With a disc on the left, the pill's own left padding steps back. */
const ICON_PADDING: Record<BadgeSize, string> = {
  default: "pl-1 sm:pl-1",
  lg: "pl-1.5 sm:pl-1",
  sm: "pl-1 sm:pl-0.5",
};

export interface BadgeProps extends useRender.ComponentProps<"span"> {
  variant?: VariantProps<typeof badgeVariants>["variant"];
  size?: VariantProps<typeof badgeVariants>["size"];
  /**
   * The leading icon. Informative variants bring their own; pass a node to
   * override it, or `null` to render the pill without one.
   */
  icon?: React.ReactNode | null;
}

export function Badge({
  className,
  variant,
  size,
  render,
  children,
  icon,
  ...props
}: BadgeProps): React.ReactElement {
  const resolvedVariant: BadgeVariant = variant ?? "default";
  const resolvedSize: BadgeSize = size ?? "default";
  // `undefined` = not stated, use the variant's own; `null` = explicitly none.
  const resolvedIcon =
    icon === undefined ? VARIANT_ICON[resolvedVariant] : icon;

  const defaultProps = {
    children: (
      <>
        {resolvedIcon != null ? (
          <span
            aria-hidden="true"
            className={cn(
              "inline-flex shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,currentColor_12%,transparent)]",
              ICON_DISC[resolvedSize]
            )}
          >
            {resolvedIcon}
          </span>
        ) : null}
        {children}
      </>
    ),
    className: cn(
      badgeVariants({ size, variant }),
      resolvedIcon != null && ICON_PADDING[resolvedSize],
      className
    ),
    "data-slot": "badge",
  };

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}
