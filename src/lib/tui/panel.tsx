/** @jsxImportSource @opentui/solid */
/**
 * The `/dcp` session panel screens, rendered into the host's
 * `session.panel` slot.
 *
 * Reads live data reactively from the `@opencode/plugin/tui` `Context`:
 *   - `data.session.get(id)`      → current session (tokens, title, model)
 *   - `data.location.model.list()`→ model catalog (context limit)
 *   - `storage.store(...)`        → the shared DCP docs (session state + all-time)
 *   - `client.session.context(id)`→ durable messages (for the context breakdown)
 *
 * The manual-mode toggle writes through the same durable store the core
 * plugin writes, so the panel and the pipeline always agree.
 */
import { createMemo, createResource, createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { usePlugin } from "@opencode/plugin/tui";
import type { DcpConfig } from "../../config.ts";
import { toWithParts, type DurableMessage } from "../compress/durable.ts";
import { analyzeContextTokens, type TokenBreakdown } from "../commands/context.ts";
import { buildSessionStatsSummary, type SessionStatsSummary } from "../commands/stats.ts";
import type { AggregatedStats } from "../state/persistence.ts";
import { ALL_TIME_KEY } from "../state/persistence.ts";
import { formatDuration, formatRatio, formatTokenCount, pct } from "../ui/utils.ts";
import {
  PANEL_NAME,
  allTimeStats,
  buildPanelState,
  currentUsageTokens,
  emptyPanelDoc,
  modelContextLimit,
  zeroAllTime,
  type AllTimeDoc,
  type PanelDoc,
} from "./data.ts";

/**
 * Structural subset of the resolved theme. The host's `ResolvedTheme`
 * (`@opencode/theme/tui`) is not installed here, so this is cast
 * defensively; any missing token falls back to the host default color.
 */
interface DcpTheme {
  primary?: string;
  text?: string;
  textMuted?: string;
  borderSubtle?: string;
  backgroundElement?: string;
  selectedListItemText?: string;
  success?: string;
  error?: string;
  background?: string;
}

/** The host TUI context, derived from the public `usePlugin` API. */
type Ctx = ReturnType<typeof usePlugin>;

/** Structural subset of the host's `session.panel` slot input (PanelInput). */
interface DcpPanelInput {
  readonly name: string;
  readonly sessionID: string;
  readonly close: () => void;
}

const themeOf = (context: Ctx): DcpTheme => context.theme as unknown as DcpTheme;

/**
 * Slot entry point: only render the DCP panel while the host is showing the
 * panel this plugin registered. The store/resource bindings key off the
 * `sessionID` prop, which is stable per slot render.
 */
export function DcpPanelHost(props: { context: Ctx; panel: DcpPanelInput; config: DcpConfig }) {
  return (
    <Show when={props.panel.name === PANEL_NAME}>
      <DcpPanel
        context={props.context}
        sessionID={props.panel.sessionID}
        config={props.config}
        onClose={props.panel.close}
      />
    </Show>
  );
}

type Screen = "overview" | "context" | "stats";

function DcpPanel(props: {
  context: Ctx;
  sessionID: string;
  config: DcpConfig;
  onClose: () => void;
}) {
  const theme = themeOf(props.context);
  const [screen, setScreen] = createSignal<Screen>("overview");

  const session = createMemo(() => props.context.data.session.get(props.sessionID));
  const usage = createMemo(() => currentUsageTokens(session()?.tokens));
  const limit = createMemo(() => {
    const model = session()?.model;
    if (!model) return undefined;
    return modelContextLimit(props.context.data.location.model.list(props.context.location), model);
  });

  const [docStore, docMutate] = props.context.storage.store<PanelDoc>(
    `dcp/state/${props.sessionID}`,
    { initial: emptyPanelDoc() },
  );
  const [allTimeStore] = props.context.storage.store<AllTimeDoc>(ALL_TIME_KEY, {
    initial: zeroAllTime,
  });

  const state = createMemo(() =>
    buildPanelState(docStore, props.sessionID, props.config.manualMode.enabled),
  );

  const [messages] = createResource(async () => {
    try {
      const entries = await props.context.client.session.context({
        sessionID: props.sessionID,
      });
      return toWithParts(entries as unknown as DurableMessage[], props.sessionID);
    } catch {
      return [];
    }
  });

  const breakdown = createMemo<TokenBreakdown | undefined>(() => {
    const list = messages();
    if (!list) return undefined;
    return analyzeContextTokens(state(), list);
  });

  const stats = createMemo<SessionStatsSummary>(() => buildSessionStatsSummary(state()));

  const manualActive = createMemo(() => state().manualMode !== false);
  const toggleManual = () => {
    const next = !manualActive();
    void docMutate((draft) => {
      draft.manualMode = next;
    });
  };

  return (
    <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
      <FrameHeader theme={theme} eyebrow="DCP" title={session()?.title} onClose={props.onClose} />
      <Show when={screen() === "overview"}>
        <Overview
          theme={theme}
          usage={usage}
          limit={limit}
          stats={stats}
          manualActive={manualActive}
          onManual={toggleManual}
          onContext={() => setScreen("context")}
          onStats={() => setScreen("stats")}
        />
      </Show>
      <Show when={screen() === "context"}>
        <ContextScreen theme={theme} breakdown={breakdown} />
      </Show>
      <Show when={screen() === "stats"}>
        <StatsScreen theme={theme} stats={stats} allTime={allTimeStats(allTimeStore)} />
      </Show>
      <FrameFooter
        theme={theme}
        screen={screen}
        onBack={() => setScreen("overview")}
        onContext={() => setScreen("context")}
        onStats={() => setScreen("stats")}
        onClose={props.onClose}
      />
    </box>
  );
}

function FrameHeader(props: {
  theme: DcpTheme;
  eyebrow: string;
  title?: string;
  onClose: () => void;
}) {
  return (
    <box flexDirection="row" justifyContent="space-between">
      <box flexDirection="column">
        <text fg={props.theme.primary} attributes={TextAttributes.BOLD}>
          {props.eyebrow}
        </text>
        {props.title ? (
          <text fg={props.theme.text} attributes={TextAttributes.BOLD}>
            {props.title}
          </text>
        ) : null}
      </box>
      <text fg={props.theme.textMuted} onMouseUp={props.onClose}>
        esc
      </text>
    </box>
  );
}

function FrameFooter(props: {
  theme: DcpTheme;
  screen: () => Screen;
  onBack: () => void;
  onContext: () => void;
  onStats: () => void;
  onClose: () => void;
}) {
  return (
    <box flexDirection="row" justifyContent="space-between" paddingTop={1}>
      <box flexDirection="row" gap={1}>
        <Show when={props.screen() !== "overview"}>
          <Button theme={props.theme} label="back" variant="muted" onClick={props.onBack} />
        </Show>
        <Show when={props.screen() === "overview"}>
          <Button theme={props.theme} label="context" variant="muted" onClick={props.onContext} />
          <Button theme={props.theme} label="stats" variant="muted" onClick={props.onStats} />
        </Show>
      </box>
      <Button theme={props.theme} label="close" variant="primary" onClick={props.onClose} />
    </box>
  );
}

function Overview(props: {
  theme: DcpTheme;
  usage: () => number;
  limit: () => number | undefined;
  stats: () => SessionStatsSummary;
  manualActive: () => boolean;
  onManual: () => void;
  onContext: () => void;
  onStats: () => void;
}) {
  return (
    <box flexDirection="column" gap={1}>
      <Card theme={props.theme} title="Context">
        <ProgressRow
          theme={props.theme}
          label="usage"
          value={props.usage()}
          total={props.limit() ?? 0}
          detail={`${formatTokenCount(props.usage())} / ${
            props.limit() !== undefined ? formatTokenCount(props.limit() ?? 0) : "no limit"
          }`}
        />
      </Card>
      <Card theme={props.theme} title="Manual mode">
        <ManualModeToggle
          theme={props.theme}
          active={props.manualActive()}
          onToggle={props.onManual}
        />
      </Card>
      <Card theme={props.theme} title="Session">
        <Metric
          theme={props.theme}
          label="pruned tokens"
          value={formatTokenCount(props.stats().sessionTokens)}
        />
        <Metric
          theme={props.theme}
          label="summary tokens"
          value={formatTokenCount(props.stats().sessionSummaryTokens)}
        />
      </Card>
      <ActionRow
        theme={props.theme}
        title="context"
        detail="Token breakdown by role"
        onClick={props.onContext}
      />
      <ActionRow
        theme={props.theme}
        title="stats"
        detail="Session and all-time stats"
        onClick={props.onStats}
      />
    </box>
  );
}

function ContextScreen(props: { theme: DcpTheme; breakdown: () => TokenBreakdown | undefined }) {
  return (
    <Show
      when={props.breakdown()}
      keyed
      fallback={<text fg={props.theme.textMuted}>loading context…</text>}
    >
      {(b: TokenBreakdown) => (
        <box flexDirection="column" gap={1}>
          <Card theme={props.theme} title="Context tokens">
            <ProgressRow
              theme={props.theme}
              label="system"
              value={b.system}
              total={b.total}
              detail={formatTokenCount(b.system)}
            />
            <ProgressRow
              theme={props.theme}
              label="user"
              value={b.user}
              total={b.total}
              detail={formatTokenCount(b.user)}
            />
            <ProgressRow
              theme={props.theme}
              label="assistant"
              value={b.assistant}
              total={b.total}
              detail={formatTokenCount(b.assistant)}
            />
            <ProgressRow
              theme={props.theme}
              label="tools"
              value={b.tools}
              total={b.total}
              detail={formatTokenCount(b.tools)}
            />
          </Card>
          <Card theme={props.theme} title="Pruned">
            <Metric
              theme={props.theme}
              label="pruned tokens"
              value={formatTokenCount(b.prunedTokens)}
            />
            <Metric theme={props.theme} label="pruned tools" value={String(b.prunedToolCount)} />
            <Metric
              theme={props.theme}
              label="pruned messages"
              value={String(b.prunedMessageCount)}
            />
            <Metric
              theme={props.theme}
              label="tools in ctx"
              value={`${b.toolsInContextCount} / ${b.toolCount}`}
            />
          </Card>
        </box>
      )}
    </Show>
  );
}

function StatsScreen(props: {
  theme: DcpTheme;
  stats: () => SessionStatsSummary;
  allTime: AggregatedStats;
}) {
  const s = props.stats();
  return (
    <box flexDirection="column" gap={1}>
      <Card theme={props.theme} title="Session">
        <Metric
          theme={props.theme}
          label="pruned tokens"
          value={formatTokenCount(s.sessionTokens)}
        />
        <Metric
          theme={props.theme}
          label="summary tokens"
          value={formatTokenCount(s.sessionSummaryTokens)}
          hint={`ratio ${formatRatio(s.sessionTokens, s.sessionSummaryTokens)}`}
        />
        <Metric theme={props.theme} label="pruned tools" value={String(s.sessionTools)} />
        <Metric theme={props.theme} label="pruned messages" value={String(s.sessionMessages)} />
        <Metric
          theme={props.theme}
          label="compress time"
          value={formatDuration(s.sessionDurationMs)}
        />
      </Card>
      <Card theme={props.theme} title="All time">
        <Metric
          theme={props.theme}
          label="tokens"
          value={formatTokenCount(props.allTime.totalTokens)}
        />
        <Metric theme={props.theme} label="tools" value={String(props.allTime.totalTools)} />
        <Metric theme={props.theme} label="messages" value={String(props.allTime.totalMessages)} />
        <Metric theme={props.theme} label="sessions" value={String(props.allTime.sessionCount)} />
      </Card>
    </box>
  );
}

function Card(props: { theme: DcpTheme; title: string; children: JSX.Element }) {
  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={props.theme.backgroundElement}
      border={["left"]}
      borderColor={props.theme.primary}
      gap={1}
    >
      <text fg={props.theme.primary} attributes={TextAttributes.BOLD}>
        {props.title}
      </text>
      {props.children}
    </box>
  );
}

function Metric(props: { theme: DcpTheme; label: string; value: string; hint?: string }) {
  return (
    <box flexDirection="row" gap={2}>
      <box width={24}>
        <text fg={props.theme.textMuted}>{props.label}</text>
      </box>
      <box flexDirection="row" gap={1} flexGrow={1}>
        <text fg={props.theme.text} attributes={TextAttributes.BOLD}>
          {props.value}
        </text>
        {props.hint ? <text fg={props.theme.textMuted}>{props.hint}</text> : null}
      </box>
    </box>
  );
}

function ProgressRow(props: {
  theme: DcpTheme;
  label: string;
  value: number;
  total: number;
  detail: string;
}) {
  const width = 32;
  const filled = props.total > 0 ? Math.max(0, Math.round((props.value / props.total) * width)) : 0;
  const empty = Math.max(0, width - filled);
  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" gap={2}>
        <box width={20}>
          <text fg={props.theme.text}>{props.label}</text>
        </box>
        <box flexDirection="row" gap={1} flexGrow={1}>
          <text fg={props.theme.text} attributes={TextAttributes.BOLD}>
            {pct(props.value, props.total)}
          </text>
          <text fg={props.theme.textMuted}>{props.detail}</text>
        </box>
      </box>
      <box flexDirection="row">
        <text fg={props.theme.primary}>{"█".repeat(filled)}</text>
        <text fg={props.theme.borderSubtle}>{"░".repeat(empty)}</text>
      </box>
    </box>
  );
}

function ManualModeToggle(props: { theme: DcpTheme; active: boolean; onToggle: () => void }) {
  const track = props.active ? props.theme.success : props.theme.error;
  return (
    <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
      <box width={22}>
        <text fg={props.theme.primary} attributes={TextAttributes.BOLD}>
          Manual mode
        </text>
      </box>
      <box backgroundColor={track} paddingLeft={1} paddingRight={1} onMouseUp={props.onToggle}>
        <text fg={props.theme.background}>{props.active ? "   ■" : "■   "}</text>
      </box>
    </box>
  );
}

function ActionRow(props: { theme: DcpTheme; title: string; detail: string; onClick: () => void }) {
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={1}
      paddingRight={1}
      onMouseUp={props.onClick}
    >
      <box flexDirection="row" gap={2}>
        <box width={12}>
          <text fg={props.theme.primary} attributes={TextAttributes.BOLD}>
            {props.title}
          </text>
        </box>
        <text fg={props.theme.text}>{props.detail}</text>
      </box>
      <box paddingLeft={2} paddingRight={2} backgroundColor={props.theme.primary}>
        <text fg={props.theme.selectedListItemText}>open</text>
      </box>
    </box>
  );
}

function Button(props: {
  theme: DcpTheme;
  label: string;
  variant: "muted" | "primary";
  onClick: () => void;
}) {
  const primary = props.variant === "primary";
  return (
    <box
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={primary ? props.theme.primary : props.theme.backgroundElement}
      onMouseUp={props.onClick}
    >
      <text fg={primary ? props.theme.selectedListItemText : props.theme.text}>{props.label}</text>
    </box>
  );
}
