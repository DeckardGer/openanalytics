"use client";

import * as React from "react";
import { SettingsPanel } from "@/components/dashboard/settings-panel";
import { SaveButton } from "@/components/ui/save-button";
import { SkeletonBar, SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { TimezoneSelect } from "@/components/ui/timezone-select";
import { LIVE_API, preferences } from "@/lib/api";

const BROWSER_ZONE_VALUE = "__browser__";

/**
 * `GET`/`PATCH /v1/me/preferences` — the user's timezone, an account-level
 * preference (it travels with the person, not the site — there is no
 * site-level timezone and none is planned). "Browser default" stores
 * `null`: never-chosen is a distinct state from UTC, and the analytics
 * reads then follow whatever zone the browser reports. The stored value is
 * flattened onto the session as `user.timezone`, which the interval provider
 * reads — so charts recut on the next session refresh after a save.
 */
export function TimezonePanel() {
  const browserZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const [selected, setSelected] = React.useState<string>(BROWSER_ZONE_VALUE);
  const [loaded, setLoaded] = React.useState(!LIVE_API);
  const [saved, setSaved] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const timeout = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(timeout.current), []);

  React.useEffect(() => {
    if (!LIVE_API) return;
    let cancelled = false;
    preferences
      .get()
      .then((current) => {
        if (cancelled) return;
        setSelected(current.timezone ?? BROWSER_ZONE_VALUE);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = () => {
    setSaved(false);
    setError(null);
    if (!LIVE_API) {
      setSaved(true);
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setSaved(false), 2000);
      return;
    }
    setBusy(true);
    preferences
      .update(selected === BROWSER_ZONE_VALUE ? null : selected)
      .then(
        (next) => {
          setBusy(false);
          setSelected(next.timezone ?? BROWSER_ZONE_VALUE);
          setSaved(true);
          clearTimeout(timeout.current);
          timeout.current = setTimeout(() => setSaved(false), 2000);
        },
        () => {
          setBusy(false);
          setError("Could not save the timezone. Try again in a moment.");
        }
      );
  };

  return (
    <SettingsPanel title="Timezone">
      {/* The house model: the chrome never waits, and the content — whose
          select cannot show the truth until the stored zone answers — stands
          in and comes into focus. A disabled select with a guessed value was
          the old behaviour, and it read as done when it was not. */}
      <SkeletonReveal
        ready={loaded}
        skeleton={
          // Pixel-matched: 20px label line, the 42px field, two 20px caption
          // lines, then the save row at its 32px button height.
          <div className="flex flex-col gap-4 p-5">
            <div className="flex flex-col gap-1.5">
              <span className="flex h-5 items-center">
                <SkeletonBar className="h-3.5 w-28" />
              </span>
              <SkeletonBar className="h-9 w-full rounded-xl" />
              <div>
                <span className="flex h-5 items-center">
                  <SkeletonBar className="h-3 w-full" />
                </span>
                <span className="flex h-5 items-center">
                  <SkeletonBar className="h-3 w-2/3" />
                </span>
              </div>
            </div>
            <SkeletonBar className="h-8 w-36 rounded-full" />
          </div>
        }
      >
        {!loaded ? null : (
          <div className="flex flex-col gap-4 p-5">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Your timezone</span>
              <TimezoneSelect
                ariaLabel="Your timezone"
                nullLabel={`Browser default (${browserZone})`}
                onPick={(zone) => setSelected(zone ?? BROWSER_ZONE_VALUE)}
                value={selected === BROWSER_ZONE_VALUE ? null : selected}
                variant="field"
              />
              <span className="text-xs leading-5 text-muted-foreground">
                The clock your dashboards are cut on: &ldquo;Today&rdquo; means
                today in this zone, on every site you can see. Browser default
                follows wherever you sign in from.
              </span>
            </div>
            <div className="flex items-center gap-3">
              <SaveButton
                onClick={save}
                size="sm"
                state={busy ? "saving" : saved ? "saved" : "idle"}
              >
                Save timezone
              </SaveButton>
              {error ? (
                <span className="text-xs text-destructive-foreground">
                  {error}
                </span>
              ) : null}
            </div>
          </div>
        )}
      </SkeletonReveal>
    </SettingsPanel>
  );
}
