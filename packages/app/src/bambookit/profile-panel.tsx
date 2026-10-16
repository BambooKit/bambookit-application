import { Button } from "@opencode-ai/ui/button"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { bambookit, bambookitApi } from "./store"

interface Plan {
  plan: "free" | "pro"
  proUntil: string | null
  limits: { phoneMessagesPerDay: number | null; phoneSessionsPerDay: number | null; desktops: number }
  usage: { phoneMessagesToday: number; phoneSessionsToday: number; desktops: number }
}

interface Achievement {
  id: string
  emoji: string
  title: string
  description: string
  unit: string
  trackable: boolean
  reason?: string
  value: number
  tier: Tier | null
  nextTier: Tier | null
  progress: number
  target: number
  unlocked: boolean
}

type Tier = "bronze" | "silver" | "gold" | "platinum" | "diamond"

interface Stats {
  achievements: Achievement[]
  achievementSummary: { unlocked: number; total: number; tiersUnlocked: number; tiersTotal: number; points: number; currentStreak: number; longestStreak: number }
  [key: string]: unknown
}

const TIER_COLOR: Record<Tier, string> = {
  bronze: "#b0773f",
  silver: "#a8b0b8",
  gold: "#d9a441",
  platinum: "#7fc4c9",
  diamond: "#8fb3ff",
}

const UPGRADE_URL = "https://bambookit-web.onrender.com/pricing/"
const limit = (n: number | null) => (n === null ? "unlimited" : String(n))

/** Plan, usage and the 50 tiered achievements, from the BambooKit API for the signed-in account. */
export function BambooKitProfilePanel(props: { onBack: () => void }) {
  const api = bambookitApi()!
  const [data] = createResource(async () => {
    const [plan, stats] = await Promise.all([api.apiGet<Plan>("/v1/me/plan"), api.apiGet<Stats>("/v1/me/stats")])
    if (!plan.ok) throw new Error(plan.error)
    if (!stats.ok) throw new Error(stats.error)
    return { plan: plan.data, stats: stats.data }
  })
  const [filter, setFilter] = createSignal<"all" | "unlocked" | "progress">("all")
  const list = createMemo(() => {
    const items = data()?.stats.achievements ?? []
    if (filter() === "unlocked") return items.filter((a) => a.unlocked)
    if (filter() === "progress") return items.filter((a) => a.trackable && !a.unlocked && a.value > 0)
    return items
  })
  const account = () => bambookit.state()?.account

  return (
    <section class="flex flex-col gap-4">
      <div class="flex items-center gap-3">
        <Show when={account()?.avatarUrl} fallback={<div class="size-10 rounded-full bg-surface-raised-base flex items-center justify-center text-14-medium">{(account()?.name ?? account()?.email ?? "?").charAt(0).toUpperCase()}</div>}>
          <img src={account()!.avatarUrl!} alt="" class="size-10 rounded-full" referrerpolicy="no-referrer" />
        </Show>
        <div class="flex flex-col min-w-0">
          <span class="text-14-medium text-text-strong truncate">{account()?.name ?? account()?.email}</span>
          <Show when={account()?.name}>
            <span class="text-12-regular text-text-weak truncate">{account()?.email}</span>
          </Show>
        </div>
      </div>

      <Show when={!data.error} fallback={<p class="text-12-regular text-text-critical-base">{String(data.error?.message ?? data.error)}</p>}>
        <Show when={data()} fallback={<p class="text-12-regular text-text-weak">Loading…</p>}>
          {(d) => (
            <>
              <div class="flex flex-col gap-1.5 rounded-md border border-border-weak-base px-3 py-2.5">
                <div class="flex items-center justify-between">
                  <span class="text-13-medium text-text-strong">{d().plan.plan === "pro" ? "BambooKit Pro" : "Free plan"}</span>
                  <Show when={d().plan.plan === "free"}>
                    <a class="text-12-medium text-text-strong underline underline-offset-2" href={UPGRADE_URL} target="_blank" rel="noopener noreferrer">
                      Upgrade · Compare plans
                    </a>
                  </Show>
                </div>
                <Show when={d().plan.plan === "pro" && d().plan.proUntil}>
                  <span class="text-12-regular text-text-weak">Pro until {new Date(d().plan.proUntil!).toLocaleDateString()}</span>
                </Show>
                <span class="text-12-regular text-text-weak">
                  Today on your phone: {d().plan.usage.phoneMessagesToday} / {limit(d().plan.limits.phoneMessagesPerDay)} messages ·{" "}
                  {d().plan.usage.phoneSessionsToday} / {limit(d().plan.limits.phoneSessionsPerDay)} new sessions
                </span>
                <span class="text-12-regular text-text-weak">
                  Computers: {d().plan.usage.desktops} / {d().plan.limits.desktops}
                </span>
              </div>

              <div class="grid grid-cols-3 gap-2 text-center">
                <Stat label="Achievements" value={`${d().stats.achievementSummary.unlocked}/${d().stats.achievementSummary.total}`} />
                <Stat label="Points" value={String(d().stats.achievementSummary.points)} />
                <Stat label="Streak" value={`${d().stats.achievementSummary.currentStreak}d`} />
              </div>

              <div class="flex gap-1">
                <For each={[["all", "All"], ["unlocked", "Unlocked"], ["progress", "In progress"]] as const}>
                  {([value, label]) => (
                    <Button size="small" variant={filter() === value ? "secondary" : "ghost"} onClick={() => setFilter(value)}>
                      {label}
                    </Button>
                  )}
                </For>
              </div>

              <div class="flex flex-col gap-1.5 max-h-[320px] overflow-y-auto pr-1">
                <Show when={list().length} fallback={<p class="text-12-regular text-text-weak">Nothing here yet.</p>}>
                  <For each={list()}>{(a) => <AchievementRow achievement={a} />}</For>
                </Show>
              </div>
            </>
          )}
        </Show>
      </Show>

      <div class="flex justify-start">
        <Button size="small" variant="ghost" onClick={props.onBack}>
          Back
        </Button>
      </div>
    </section>
  )
}

function Stat(props: { label: string; value: string }) {
  return (
    <div class="flex flex-col rounded-md border border-border-weak-base py-2">
      <span class="text-14-medium text-text-strong">{props.value}</span>
      <span class="text-11-regular text-text-weak">{props.label}</span>
    </div>
  )
}

function AchievementRow(props: { achievement: Achievement }) {
  const a = () => props.achievement
  const color = () => (a().tier ? TIER_COLOR[a().tier!] : "transparent")
  const pct = () => (a().target > 0 ? Math.min(100, Math.round((a().progress / a().target) * 100)) : 0)
  return (
    <div class="flex items-center gap-3 rounded-md border border-border-weak-base px-3 py-2" classList={{ "opacity-60": !a().unlocked }}>
      <div class="flex size-9 shrink-0 items-center justify-center rounded-full border-2 text-16-medium" style={{ "border-color": a().tier ? color() : "var(--border-weak-base, #333)" }}>
        {a().emoji}
      </div>
      <div class="flex flex-col min-w-0 flex-1 gap-0.5">
        <div class="flex items-center gap-2">
          <span class="text-13-medium text-text-strong truncate">{a().title}</span>
          <Show when={a().tier}>
            <span class="text-11-medium capitalize" style={{ color: color() }}>
              {a().tier}
            </span>
          </Show>
        </div>
        <span class="text-11-regular text-text-weak truncate">{a().trackable ? a().description : (a().reason ?? a().description)}</span>
        <Show when={a().trackable && a().nextTier}>
          <div class="flex items-center gap-2">
            <div class="h-1 flex-1 rounded-full bg-surface-raised-base overflow-hidden">
              <div class="h-full rounded-full bg-text-strong" style={{ width: `${pct()}%` }} />
            </div>
            <span class="text-11-regular text-text-weak shrink-0">
              {a().progress}/{a().target} {a().unit} → <span class="capitalize">{a().nextTier}</span>
            </span>
          </div>
        </Show>
      </div>
    </div>
  )
}
