"use client";

import * as React from "react";
import { SettingsPanel } from "@/components/dashboard/settings-panel";
import { Button } from "@/components/ui/button";
import { SaveButton } from "@/components/ui/save-button";
import { SkeletonBar, SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { Switch } from "@/components/ui/switch";
import { deployment, LIVE_API, type DeploymentSettings } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Deployment — what this install needs from a third party, typed here instead
 * of into a file on the host.
 *
 * The wall this removes is specific. A fresh self-hosted install cannot invite
 * anybody (no mail relay) and cannot use the assistant (no model provider), and
 * both are `docker compose` edits followed by a restart. Nothing in the product
 * said so, so the first thing a new operator did after signing in was hit a
 * dead end with no explanation.
 *
 * Two rules shape every panel below.
 *
 * **A secret is never read back.** The API returns whether one is stored and its
 * last four characters, so the password field is always empty and always
 * optional: leaving it alone keeps what is stored. That is why each panel says
 * so in words rather than hoping a masked placeholder is understood.
 *
 * **Mail is proved by sending, not by saving.** The api holds no relay
 * credential — the worker delivers — so a save cannot report that the settings
 * work. The test button queues a message to the operator's own address and the
 * panel watches the row, which is the only honest way to answer the question.
 */

const inputClass =
  "h-9 w-full rounded-xl border border-input bg-white px-3 text-sm outline-none transition-[box-shadow,border-color] focus-visible:border-ring focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px]";

type Stored = NonNullable<DeploymentSettings["email"]>["stored"];

export interface DeploymentState {
  readonly settings: DeploymentSettings | null;
  readonly loaded: boolean;
  reload: () => void;
}

/**
 * The one read the screen turns on, shared by the tab that decides whether to
 * exist and the panels inside it.
 *
 * A failed read leaves `settings` null, which every consumer reads as "not
 * editable" — the conservative direction: a dashboard that cannot ask whether
 * it may configure the deployment should not offer to.
 */
export function useDeploymentSettings(): DeploymentState {
  const [settings, setSettings] = React.useState<DeploymentSettings | null>(
    null
  );
  const [loaded, setLoaded] = React.useState(!LIVE_API);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    if (!LIVE_API) return;
    let cancelled = false;
    deployment
      .get()
      .then((next) => {
        if (cancelled) return;
        setSettings(next);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return {
    settings,
    loaded,
    reload: React.useCallback(() => setNonce((n) => n + 1), []),
  };
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? (
        <span className="text-xs leading-5 text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

/** The two-line skeleton every panel here stands in with. */
function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-5">
      <SkeletonBar className="h-9 w-full rounded-xl" />
      <SkeletonBar className="h-9 w-full rounded-xl" />
      <SkeletonBar className="h-8 w-36 rounded-full" />
    </div>
  );
}

export function DeploymentSection({ state }: { state: DeploymentState }) {
  const settings = state.settings;

  return (
    <>
      <SkeletonReveal ready={state.loaded} skeleton={<PanelSkeleton />}>
        {!state.loaded ? null : (
          <div className="flex flex-col gap-6">
            <EmailPanel
              onSaved={state.reload}
              stored={settings?.email?.stored ?? null}
            />
            <AssistantPanel
              environment={settings?.assistant?.environment ?? null}
              onSaved={state.reload}
              source={settings?.assistant?.source ?? "none"}
              stored={settings?.assistant?.stored ?? null}
            />
          </div>
        )}
      </SkeletonReveal>
    </>
  );
}

type SaveState = "idle" | "saving" | "saved";

/** The 2 s "saved" beat every panel here shares. */
function useSaveBeat() {
  const [state, setState] = React.useState<SaveState>("idle");
  const timeout = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(timeout.current), []);
  return {
    state,
    setState,
    beat: () => {
      setState("saved");
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setState("idle"), 2000);
    },
  };
}

function EmailPanel({
  stored,
  onSaved,
}: {
  stored: Stored | null;
  onSaved: () => void;
}) {
  const [host, setHost] = React.useState(String(stored?.host ?? ""));
  const [port, setPort] = React.useState(String(stored?.port ?? 587));
  const [secure, setSecure] = React.useState(stored?.secure ?? false);
  const [user, setUser] = React.useState(String(stored?.user ?? ""));
  const [from, setFrom] = React.useState(String(stored?.from ?? ""));
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const save = useSaveBeat();

  const [test, setTest] = React.useState<{
    phase: "idle" | "queued" | "delivered" | "failed";
    detail: string | null;
  }>({ phase: "idle", detail: null });

  const submit = () => {
    setError(null);
    if (host.trim() === "") {
      setError("Enter the mail server’s hostname.");
      return;
    }
    save.setState("saving");
    deployment
      .putEmail({
        host: host.trim(),
        port: Number(port) || 587,
        secure,
        user: user.trim() === "" ? null : user.trim(),
        from: from.trim() === "" ? null : from.trim(),
        // Omitted when the box is empty, which is what keeps a stored password
        // through an edit to any other field.
        ...(password === "" ? {} : { password }),
      })
      .then(
        () => {
          setPassword("");
          save.beat();
          onSaved();
        },
        (err: unknown) => {
          save.setState("idle");
          setError(messageFrom(err, "Could not save the mail settings."));
        }
      );
  };

  const remove = () => {
    setError(null);
    deployment.clearEmail().then(
      () => {
        setHost("");
        setUser("");
        setFrom("");
        setPassword("");
        setPort("587");
        setSecure(false);
        onSaved();
      },
      (err: unknown) =>
        setError(messageFrom(err, "Could not remove the mail settings."))
    );
  };

  /**
   * Queue a test and watch the row until the worker has finished with it.
   *
   * Polled rather than streamed: the answer arrives within one drain interval
   * (five seconds) and a dedicated stream for a button nobody presses twice a
   * month would be a socket to operate for nothing. It gives up after ~30 s and
   * says the message is still queued, which is true and is what an operator with
   * a dead relay should be told rather than a spinner that never stops.
   */
  const sendTest = async () => {
    setTest({ phase: "queued", detail: null });
    let deliveryId: string | null;
    try {
      const queued = await deployment.sendTestEmail();
      deliveryId = queued.delivery_id;
      setTest({ phase: "queued", detail: `Queued to ${queued.to}.` });
    } catch (err) {
      setTest({
        phase: "failed",
        detail: messageFrom(err, "Could not queue the test message."),
      });
      return;
    }
    if (deliveryId === null) return;

    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      let status;
      try {
        status = await deployment.testEmailStatus(deliveryId);
      } catch {
        continue;
      }
      if (status.status === "delivered") {
        setTest({
          phase: "delivered",
          detail: "Delivered. Check your inbox — and your spam folder.",
        });
        return;
      }
      if (status.status === "failed" || status.reason !== null) {
        setTest({ phase: "failed", detail: relayFailure(status.reason) });
        if (status.status === "failed") return;
      }
    }
    setTest((current) => ({
      phase: current.phase === "failed" ? "failed" : "queued",
      detail:
        current.phase === "failed"
          ? current.detail
          : "Still queued. The worker may be down, or it has no transport at all — check its logs for email_transport_selected.",
    }));
  };

  return (
    <SettingsPanel title="Email">
      <div className="flex flex-col gap-4 p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_7rem]">
          <Field label="Mail server">
            <input
              autoComplete="off"
              className={inputClass}
              onChange={(event) => setHost(event.target.value)}
              placeholder="smtp.example.com"
              value={host}
            />
          </Field>
          <Field label="Port">
            <input
              className={inputClass}
              inputMode="numeric"
              onChange={(event) => setPort(event.target.value)}
              value={port}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Username" hint="Leave empty for a relay that takes no credential.">
            <input
              autoComplete="off"
              className={inputClass}
              onChange={(event) => setUser(event.target.value)}
              value={user}
            />
          </Field>
          <Field
            label="Password"
            hint={
              stored?.secret_set
                ? `Stored, ending ${stored.secret_last4 || "—"}. Leave empty to keep it.`
                : "Stored encrypted; it is never shown again."
            }
          >
            <input
              autoComplete="new-password"
              className={inputClass}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={stored?.secret_set ? "••••••••" : ""}
              type="password"
              value={password}
            />
          </Field>
        </div>

        <Field
          label="From address"
          hint="Most relays refuse a sender that is not the authenticated mailbox. “Name <address>” works."
        >
          <input
            autoComplete="off"
            className={inputClass}
            onChange={(event) => setFrom(event.target.value)}
            placeholder="Open Analytics <analytics@example.com>"
            value={from}
          />
        </Field>

        <div className="flex items-center gap-3">
          <Switch
            aria-label="Implicit TLS"
            checked={secure}
            onCheckedChange={(next: boolean) => setSecure(next)}
          />
          <span className="text-xs leading-5 text-muted-foreground">
            Implicit TLS from the first byte. On for port 465; leave it off for
            587, where the connection is still upgraded with STARTTLS.
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <SaveButton onClick={submit} size="sm" state={save.state}>
            Save mail settings
          </SaveButton>
          <Button
            disabled={test.phase === "queued"}
            onClick={() => void sendTest()}
            size="sm"
            variant="outline"
          >
            Send a test
          </Button>
          {stored ? (
            <Button onClick={remove} size="sm" variant="ghost">
              Use the environment instead
            </Button>
          ) : null}
          {error ? (
            <span className="text-xs text-destructive-foreground">{error}</span>
          ) : null}
        </div>

        {test.detail ? (
          <p
            className={cn(
              "text-xs leading-5",
              test.phase === "failed"
                ? "text-destructive-foreground"
                : "text-muted-foreground"
            )}
          >
            {test.detail}
          </p>
        ) : null}

        {stored ? null : (
          <p className="text-xs leading-5 text-muted-foreground">
            Nothing is stored here, so the worker uses its own environment. If it
            has <code>SMTP_HOST</code> or <code>RESEND_API_KEY</code> set, mail
            already works — send a test to find out.
          </p>
        )}
      </div>
    </SettingsPanel>
  );
}

function AssistantPanel({
  stored,
  source,
  environment,
  onSaved,
}: {
  stored: Stored | null;
  source: string;
  environment: { model?: string; base_url?: string } | null;
  onSaved: () => void;
}) {
  const [apiKey, setApiKey] = React.useState("");
  const [model, setModel] = React.useState(String(stored?.model ?? ""));
  const [baseUrl, setBaseUrl] = React.useState(String(stored?.base_url ?? ""));
  const [error, setError] = React.useState<string | null>(null);
  const save = useSaveBeat();

  const submit = () => {
    setError(null);
    if (!stored?.secret_set && apiKey.trim() === "") {
      setError("Enter the provider API key.");
      return;
    }
    save.setState("saving");
    deployment
      .putAssistant({
        ...(apiKey === "" ? {} : { api_key: apiKey.trim() }),
        model: model.trim() === "" ? null : model.trim(),
        base_url: baseUrl.trim() === "" ? null : baseUrl.trim(),
      })
      .then(
        () => {
          setApiKey("");
          save.beat();
          onSaved();
        },
        (err: unknown) => {
          save.setState("idle");
          setError(messageFrom(err, "Could not save the provider."));
        }
      );
  };

  const remove = () => {
    setError(null);
    deployment.clearAssistant().then(
      () => {
        setApiKey("");
        setModel("");
        setBaseUrl("");
        onSaved();
      },
      (err: unknown) => setError(messageFrom(err, "Could not remove the key."))
    );
  };

  return (
    <SettingsPanel title="Assistant">
      <div className="flex flex-col gap-4 p-5">
        <Field
          label="Provider API key"
          hint={
            stored?.secret_set
              ? `Stored, ending ${stored.secret_last4 || "—"}. Leave empty to keep it.`
              : "An OpenAI key, or any endpoint that speaks the same API. Stored encrypted; it is never shown again."
          }
        >
          <input
            autoComplete="new-password"
            className={inputClass}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={stored?.secret_set ? "••••••••" : "sk-…"}
            type="password"
            value={apiKey}
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Model">
            <input
              className={inputClass}
              onChange={(event) => setModel(event.target.value)}
              placeholder={environment?.model ?? "gpt-5.5"}
              value={model}
            />
          </Field>
          <Field label="Base URL">
            <input
              className={inputClass}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={environment?.base_url ?? "https://api.openai.com"}
              value={baseUrl}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <SaveButton onClick={submit} size="sm" state={save.state}>
            Save provider
          </SaveButton>
          {stored ? (
            <Button onClick={remove} size="sm" variant="ghost">
              Remove
            </Button>
          ) : null}
          {error ? (
            <span className="text-xs text-destructive-foreground">{error}</span>
          ) : null}
        </div>

        <p className="text-xs leading-5 text-muted-foreground">
          {source === "database"
            ? "The assistant uses this key. It takes effect on the next question — no restart."
            : source === "environment"
              ? "The assistant is using OPENAI_API_KEY from the api’s environment. A key saved here replaces it."
              : "Without a provider the assistant stays out of the way: the chat button is there but disabled."}
        </p>
      </div>
    </SettingsPanel>
  );
}

/** The three transport outcomes, as the operator's next move. */
function relayFailure(reason: string | null): string {
  switch (reason) {
    case "unauthorized":
      return "The relay rejected the username or password.";
    case "unavailable":
      return "The relay could not be reached. Check the host, the port, and whether the container can leave the network.";
    case "invalid":
      return "The relay refused the message. This is usually a From address it will not send as.";
    case "invalid_payload":
      return "The queued message was malformed. Please report this.";
    default:
      return "The message could not be delivered.";
  }
}

/** An `ApiError`'s message when there is one, and a written fallback otherwise. */
function messageFrom(err: unknown, fallback: string): string {
  const message =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message: unknown }).message)
      : "";
  return message === "" ? fallback : message;
}
