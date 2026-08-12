"use client";

import {
  ArrowDown01Icon,
  BrowserIcon as BrowserCardIcon,
  SmartPhone01Icon,
} from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import {
  AnalyticsCardBody,
  BreakdownRow,
  useSiteAnalytics,
} from "@/components/dashboard/analytics-card";
import { ImportedGapNote } from "@/components/dashboard/data-state";
import { HoverList } from "@/components/dashboard/hover-list";
import {
  SeeAllModal,
  SeeAllSkeleton,
  useIntervalLabel,
} from "@/components/dashboard/see-all-modal";
import {
  BrowserIcon,
  DeviceGlyph,
  OSIcon,
} from "@/components/dashboard/tech-icons";
import {
  DropdownMenu,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  SquircleCard,
  SquircleCardScroll,
} from "@/components/ui/squircle-card";
import {
  getAnalyticsDevices,
  type AnalyticsMeta,
  type DeviceRow,
} from "@/lib/api";
import { MOCK_DEVICES } from "@/lib/mock";

/**
 * Devices and Browsers, both cut from one
 * `GET /v1/sites/{site_id}/analytics/devices` read — the contract row is the
 * device_type × browser × os combination, so the two cards are two foldings
 * of the same response and fetching twice would be the same bytes twice.
 *
 * Folding sums per-combination visitor counts, so a visitor seen on two
 * browsers counts once per browser — a small, deliberate over-count.
 */

export function fold(
  items: DeviceRow[],
  keyOf: (row: DeviceRow) => string
): Array<{ label: string; visitors: number }> {
  const byLabel = new Map<string, number>();
  for (const row of items) {
    const label = keyOf(row);
    byLabel.set(label, (byLabel.get(label) ?? 0) + row.visitors);
  }
  return [...byLabel.entries()]
    .map(([label, visitors]) => ({ label, visitors }))
    .sort((a, b) => b.visitors - a.visitors);
}

export const DEVICE_LABEL: Record<string, string> = {
  desktop: "Desktop",
  mobile: "Mobile",
  tablet: "Tablet",
  unknown: "Other",
};

/** The rollup stores lowercase tokens ("chrome", "samsung internet"). */
export function titleCase(value: string): string {
  return value
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Families whose house spelling beats naive title-casing. */
const FAMILY_LABEL: Record<string, string> = { ios: "iOS", macos: "macOS" };
export function familyLabel(value: string): string {
  if (value === "unknown") return "Other";
  return FAMILY_LABEL[value] ?? titleCase(value);
}

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;

type TechView = "browsers" | "os";

const TECH_VIEWS: { id: TechView; label: string }[] = [
  { id: "browsers", label: "Browsers" },
  { id: "os", label: "OS" },
];

export function DeviceCards() {
  const resource = useSiteAnalytics(getAnalyticsDevices, MOCK_DEVICES);
  const [techView, setTechView] = React.useState<TechView>("browsers");
  const [openDevices, setOpenDevices] = React.useState(false);
  const [openTech, setOpenTech] = React.useState(false);
  const currentTech =
    TECH_VIEWS.find((entry) => entry.id === techView) ?? TECH_VIEWS[0];
  const items = resource.status === "ready" ? resource.data.items : null;
  const meta = resource.status === "ready" ? resource.data.meta : null;

  return (
    <>
      <SquircleCard
        title="Devices"
        icon={<SmartPhone01Icon aria-hidden="true" />}
        onSeeAll={() => setOpenDevices(true)}
      >
        <AnalyticsCardBody
          emptyBody="No visits in this range yet."
          isEmpty={(data) => data.items.length === 0}
          resource={resource}
        >
          {(data) => {
            // Folded on the raw device_type so the row still knows which
            // glyph it wears; the label prettifies at render.
            const devices = fold(data.items, (row) => row.device_type);
            const total = devices.reduce(
              (sum, device) => sum + device.visitors,
              0
            );
            return (
              <HoverList>
                {devices.map((device) => (
                  <BreakdownRow
                    icon={
                      <DeviceGlyph
                        deviceType={device.label}
                        className="size-4"
                      />
                    }
                    key={device.label}
                    name={DEVICE_LABEL[device.label] ?? device.label}
                    pct={Math.round((device.visitors / Math.max(total, 1)) * 100)}
                    value={device.visitors.toLocaleString("en-US")}
                  />
                ))}
              </HoverList>
            );
          }}
        </AnalyticsCardBody>
      </SquircleCard>

      <SquircleCard
        icon={<BrowserCardIcon aria-hidden="true" />}
        onSeeAll={() => setOpenTech(true)}
        title={
          <DropdownMenu
            align="start"
            className="w-36"
            trigger={
              <button
                className="flex cursor-pointer items-center gap-1 rounded-lg py-0.5 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
              >
                {/* the house label swap — the title glides on cut change */}
                <AnimatePresence initial={false} mode="popLayout">
                  <motion.span
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: -9, opacity: 0, transition: { duration: 0.1 } }}
                    initial={{ y: 9, opacity: 0 }}
                    key={currentTech.id}
                    transition={SPRING}
                  >
                    {currentTech.label}
                  </motion.span>
                </AnimatePresence>
                <ArrowDown01Icon
                  aria-hidden="true"
                  className="!size-3.5 text-muted-foreground/70"
                />
              </button>
            }
          >
            {TECH_VIEWS.map((entry) => (
              <DropdownMenuItem
                key={entry.id}
                onClick={() => setTechView(entry.id)}
              >
                {entry.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenu>
        }
      >
        <AnalyticsCardBody
          emptyBody="No visits in this range yet."
          isEmpty={(data) => data.items.length === 0}
          resource={resource}
        >
          {(data) => {
            // Folded on the raw family so the row can wear its real mark;
            // "unknown"/"" collapse to one bucket first.
            const families = fold(data.items, (row) => {
              const value = techView === "browsers" ? row.browser : row.os;
              return value === "unknown" || value === "" ? "unknown" : value;
            });
            const max = Math.max(
              ...families.map((family) => family.visitors),
              1
            );
            return (
              <AnimatePresence initial={false} mode="wait">
                <motion.div
                  animate={{ opacity: 1, y: 0 }}
                  className="h-full"
                  exit={{ opacity: 0, y: -6, transition: { duration: 0.1 } }}
                  initial={{ opacity: 0, y: 8 }}
                  key={techView}
                  transition={SPRING}
                >
                  <SquircleCardScroll>
                    {/* Only the imported *device type* rows merge into this
                        report. A live row is a joint (device, browser, os)
                        tuple, and blending one-dimension imported rows into it
                        would invent tuples — so imported browsers and
                        operating systems are read separately and are absent
                        here. */}
                    <ImportedGapNote
                      className="px-5 pb-1 pt-2"
                      kind="devices"
                      meta={data.meta}
                    />
                    <HoverList>
                      {families.map((family) => (
                        <BreakdownRow
                          icon={
                            techView === "browsers" ? (
                              <BrowserIcon
                                family={family.label}
                                className="size-4"
                              />
                            ) : (
                              <OSIcon
                                family={family.label}
                                className="size-4"
                              />
                            )
                          }
                          key={family.label}
                          name={familyLabel(family.label)}
                          pct={Math.round((family.visitors / max) * 100)}
                          value={family.visitors.toLocaleString("en-US")}
                        />
                      ))}
                    </HoverList>
                  </SquircleCardScroll>
                </motion.div>
              </AnimatePresence>
            );
          }}
        </AnalyticsCardBody>
      </SquircleCard>

      <AnimatePresence>
        {openDevices && (
          <DevicesModal items={items} onClose={() => setOpenDevices(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {openTech && (
          <TechModal
            items={items}
            meta={meta}
            view={techView}
            onClose={() => setOpenTech(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

/** Every device class, in the vertical shell — a short list, same door. */
function DevicesModal({
  items,
  onClose,
}: {
  items: DeviceRow[] | null;
  onClose: () => void;
}) {
  const intervalLabel = useIntervalLabel();
  const devices =
    items === null ? null : fold(items, (row) => row.device_type);
  const total =
    devices === null
      ? 1
      : Math.max(
          devices.reduce((sum, device) => sum + device.visitors, 0),
          1
        );

  return (
    <SeeAllModal
      title="Devices"
      subtitle={`What your visitors browse on · ${intervalLabel}`}
      onClose={onClose}
    >
      {devices === null ? (
        <SeeAllSkeleton />
      ) : (
        // the shared white glide, rounded for the grey band
        <HoverList className="[&>li>span]:rounded-[10px]">
          {devices.map((device) => (
            <BreakdownRow
              icon={
                <DeviceGlyph deviceType={device.label} className="size-4" />
              }
              key={device.label}
              name={DEVICE_LABEL[device.label] ?? device.label}
              pct={Math.round((device.visitors / total) * 100)}
              value={device.visitors.toLocaleString("en-US")}
            />
          ))}
        </HoverList>
      )}
    </SeeAllModal>
  );
}

/** The whole browser or OS ranking, whichever cut the card is on. */
function TechModal({
  items,
  meta,
  view,
  onClose,
}: {
  items: DeviceRow[] | null;
  meta: AnalyticsMeta | null;
  view: TechView;
  onClose: () => void;
}) {
  const intervalLabel = useIntervalLabel();
  const current = TECH_VIEWS.find((entry) => entry.id === view) ?? TECH_VIEWS[0];
  const families =
    items === null
      ? null
      : fold(items, (row) => {
          const value = view === "browsers" ? row.browser : row.os;
          return value === "unknown" || value === "" ? "unknown" : value;
        });
  const max =
    families === null
      ? 1
      : Math.max(...families.map((family) => family.visitors), 1);

  return (
    <SeeAllModal
      title={current.label}
      subtitle={`What your visitors browse with · ${intervalLabel}`}
      onClose={onClose}
    >
      {families === null ? (
        <SeeAllSkeleton />
      ) : (
        <>
          {meta !== null ? (
            <ImportedGapNote
              className="px-4 pb-1 pt-1"
              kind="devices"
              meta={meta}
            />
          ) : null}
          {/* the shared white glide, rounded for the grey band */}
          <HoverList className="[&>li>span]:rounded-[10px]">
            {families.map((family) => (
              <BreakdownRow
                icon={
                  view === "browsers" ? (
                    <BrowserIcon family={family.label} className="size-4" />
                  ) : (
                    <OSIcon family={family.label} className="size-4" />
                  )
                }
                key={family.label}
                name={familyLabel(family.label)}
                pct={Math.round((family.visitors / max) * 100)}
                value={family.visitors.toLocaleString("en-US")}
              />
            ))}
          </HoverList>
        </>
      )}
    </SeeAllModal>
  );
}
