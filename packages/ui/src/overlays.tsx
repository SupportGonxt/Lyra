/**
 * Overlays — Dialog, Drawer, Toast, Tooltip, Menu, Popover, CommandBar.
 * All Radix-backed: focus trap, escape/dismiss, and portal behaviour come from
 * the primitive; we only supply Constellation surfaces.
 *
 * docs/15 §4: AI never opens a modal. These are for human-initiated work.
 */
import * as React from "react";
import {
  Dialog as RDialog,
  DropdownMenu as RMenu,
  Popover as RPopover,
  Toast as RToast,
  Tooltip as RTooltip,
  VisuallyHidden as RVisuallyHidden
} from "radix-ui";
import { cn, focusRing } from "./cn.js";
import { Input } from "./primitives.js";
import { useUiText } from "./text.js";

const overlayScrim = "fixed inset-0 z-40 bg-ink-900/70 data-[state=open]:animate-fade";

/* -------------------------------------------------------------------------- */
/* Dialog (Modal)                                                              */
/* -------------------------------------------------------------------------- */

export interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Required: it is the dialog's accessible name. */
  title: string;
  /** Strongly recommended; irreversible actions must state the consequence. */
  description?: React.ReactNode;
  trigger?: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  children?: React.ReactNode;
  /** Close button's accessible name. Defaults to the kit catalogue in the ambient locale. */
  closeLabel?: string;
  /**
   * Where focus goes when the dialog closes. Radix returns it to a
   * `trigger` it rendered itself; a dialog opened by state (ConfirmButton, the
   * palette) has none, so focus fell to <body> and a keyboard user started
   * again from the top of the page.
   */
  returnFocus?: React.RefObject<HTMLElement | null>;
}

const dialogSizes = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl" } as const;

export function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  title,
  description,
  trigger,
  footer,
  size = "md",
  children,
  closeLabel,
  returnFocus
}: DialogProps) {
  const t = useUiText();
  return (
    <RDialog.Root
      {...(open !== undefined ? { open } : {})}
      {...(defaultOpen !== undefined ? { defaultOpen } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {trigger ? <RDialog.Trigger asChild>{trigger}</RDialog.Trigger> : null}
      <RDialog.Portal>
        <RDialog.Overlay className={overlayScrim} />
        <RDialog.Content
          onCloseAutoFocus={(event) => {
            if (!returnFocus?.current) return;
            event.preventDefault();
            returnFocus.current.focus();
          }}
          className={cn(
            "fixed top-1/2 z-50 w-[calc(100%-2rem)] -translate-y-1/2 rounded-lg border border-border bg-surface-2 p-6 text-start shadow-raised",
            "start-1/2 -translate-x-1/2 rtl:translate-x-1/2",
            dialogSizes[size]
          )}
        >
          <RDialog.Title className="font-display text-22 font-semibold leading-[1.25] text-text">
            {title}
          </RDialog.Title>
          {description ? (
            <RDialog.Description className="mt-2 font-ui text-14 text-muted">
              {description}
            </RDialog.Description>
          ) : (
            <RVisuallyHidden.Root>
              <RDialog.Description>{title}</RDialog.Description>
            </RVisuallyHidden.Root>
          )}
          <div className="mt-4">{children}</div>
          {footer ? <div className="mt-6 flex justify-end gap-2">{footer}</div> : null}
          <RDialog.Close
            aria-label={closeLabel ?? t("close")}
            className={cn(
              "absolute top-4 end-4 rounded-sm p-1 text-subtle hover:text-text",
              focusRing
            )}
          >
            <span aria-hidden="true">✕</span>
          </RDialog.Close>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* Drawer — side sheets. `side` is logical, so it mirrors under RTL.           */
/* -------------------------------------------------------------------------- */

export interface DrawerProps extends Omit<DialogProps, "size"> {
  side?: "inline-start" | "inline-end" | "block-end";
  width?: string;
}

const drawerSides = {
  "inline-start": "inset-y-0 start-0 h-full border-e",
  "inline-end": "inset-y-0 end-0 h-full border-s",
  "block-end": "inset-x-0 bottom-0 w-full border-t rounded-t-lg"
} as const;

export function Drawer({
  open,
  defaultOpen,
  onOpenChange,
  title,
  description,
  trigger,
  footer,
  side = "inline-end",
  width = "26rem",
  children,
  closeLabel
}: DrawerProps) {
  const t = useUiText();
  return (
    <RDialog.Root
      {...(open !== undefined ? { open } : {})}
      {...(defaultOpen !== undefined ? { defaultOpen } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {trigger ? <RDialog.Trigger asChild>{trigger}</RDialog.Trigger> : null}
      <RDialog.Portal>
        <RDialog.Overlay className={overlayScrim} />
        <RDialog.Content
          style={side === "block-end" ? undefined : { inlineSize: width, maxInlineSize: "100%" }}
          className={cn(
            "fixed z-50 flex flex-col border-border bg-surface-1 text-start shadow-raised",
            drawerSides[side]
          )}
        >
          <header className="flex items-start justify-between gap-4 border-b border-border p-5">
            <div>
              <RDialog.Title className="section-title">
                {title}
              </RDialog.Title>
              {description ? (
                <RDialog.Description className="mt-1 font-ui text-13 text-subtle">
                  {description}
                </RDialog.Description>
              ) : (
                <RVisuallyHidden.Root>
                  <RDialog.Description>{title}</RDialog.Description>
                </RVisuallyHidden.Root>
              )}
            </div>
            <RDialog.Close
              aria-label={closeLabel ?? t("close")}
              className={cn("rounded-sm p-1 text-subtle hover:text-text", focusRing)}
            >
              <span aria-hidden="true">✕</span>
            </RDialog.Close>
          </header>
          <div className="flex-1 overflow-y-auto p-5">{children}</div>
          {footer ? (
            <footer className="flex justify-end gap-2 border-t border-border p-5">{footer}</footer>
          ) : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* Tooltip                                                                     */
/* -------------------------------------------------------------------------- */

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom";
  delayDuration?: number;
}

/**
 * A tooltip is never the only source of a label (docs/07 §5) — controls carry
 * their own accessible name; this adds detail, not identity.
 */
export function Tooltip({ content, children, side = "top", delayDuration = 200 }: TooltipProps) {
  return (
    <RTooltip.Provider delayDuration={delayDuration}>
      <RTooltip.Root>
        <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
        <RTooltip.Portal>
          <RTooltip.Content
            side={side}
            sideOffset={6}
            className="z-50 max-w-72 rounded-md border border-border bg-surface-3 px-2.5 py-1.5 font-ui text-12 text-text shadow-glow"
          >
            {content}
            <RTooltip.Arrow className="fill-surface-3" />
          </RTooltip.Content>
        </RTooltip.Portal>
      </RTooltip.Root>
    </RTooltip.Provider>
  );
}

/* -------------------------------------------------------------------------- */
/* Popover                                                                     */
/* -------------------------------------------------------------------------- */

export interface PopoverProps {
  trigger: React.ReactNode;
  /** Accessible name for the popover surface. */
  label: string;
  children: React.ReactNode;
  side?: "top" | "bottom";
  className?: string;
}

export function Popover({ trigger, label, children, side = "bottom", className }: PopoverProps) {
  return (
    <RPopover.Root>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          side={side}
          sideOffset={6}
          aria-label={label}
          className={cn(
            "z-50 w-80 rounded-md border border-border bg-surface-2 p-4 text-start font-ui text-14 text-muted shadow-glow",
            className
          )}
        >
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* Menu                                                                        */
/* -------------------------------------------------------------------------- */

export interface MenuItem {
  id: string;
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
  /** Decorative only — the label is always rendered. */
  icon?: React.ReactNode;
  shortcut?: string;
}

export interface MenuProps {
  trigger: React.ReactNode;
  items: MenuItem[];
  /** Accessible name for the menu. */
  label: string;
}

export function Menu({ trigger, items, label }: MenuProps) {
  return (
    <RMenu.Root>
      <RMenu.Trigger asChild>{trigger}</RMenu.Trigger>
      <RMenu.Portal>
        <RMenu.Content
          aria-label={label}
          sideOffset={6}
          align="start"
          className="z-50 min-w-52 rounded-md border border-border bg-surface-2 p-1 text-start shadow-glow"
        >
          {items.map((item) => (
            <RMenu.Item
              key={item.id}
              {...(item.disabled ? { disabled: true } : {})}
              {...(item.onSelect ? { onSelect: item.onSelect } : {})}
              className={cn(
                "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-2 font-ui text-14",
                "data-[highlighted]:bg-surface-3 data-[highlighted]:outline-none data-[disabled]:opacity-40",
                item.tone === "danger" ? "text-danger" : "text-muted data-[highlighted]:text-text"
              )}
            >
              {item.icon ? <span aria-hidden="true">{item.icon}</span> : null}
              <span className="flex-1">{item.label}</span>
              {item.shortcut ? (
                <kbd className="font-mono text-12 text-subtle">{item.shortcut}</kbd>
              ) : null}
            </RMenu.Item>
          ))}
        </RMenu.Content>
      </RMenu.Portal>
    </RMenu.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* Toast                                                                       */
/* -------------------------------------------------------------------------- */

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  tone?: "neutral" | "success" | "danger" | "info";
  /** Errors carry a copyable trace id (docs/07 §5). */
  traceId?: string;
  duration?: number;
}

interface ToastApi {
  toast: (message: Omit<ToastMessage, "id"> & { id?: string }) => void;
  dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const toastTones = {
  neutral: "border-border",
  success: "border-success/50",
  danger: "border-danger/50",
  info: "border-info/50"
} as const;

export function ToastProvider({
  children,
  dismissLabel
}: {
  children: React.ReactNode;
  /** Dismiss button's accessible name. Defaults to the kit catalogue in the ambient locale. */
  dismissLabel?: string;
}) {
  const t = useUiText();
  const [messages, setMessages] = React.useState<ToastMessage[]>([]);
  const api = React.useMemo<ToastApi>(
    () => ({
      toast: (m) =>
        setMessages((prev) => [...prev, { ...m, id: m.id ?? `t${Date.now()}${prev.length}` }]),
      dismiss: (id) => setMessages((prev) => prev.filter((m) => m.id !== id))
    }),
    []
  );

  return (
    <ToastContext.Provider value={api}>
      <RToast.Provider swipeDirection="right">
        {children}
        {messages.map((m) => (
          <RToast.Root
            key={m.id}
            duration={m.duration ?? 6000}
            onOpenChange={(open) => {
              if (!open) api.dismiss(m.id);
            }}
            className={cn(
              "rounded-md border bg-surface-2 p-4 text-start shadow-raised",
              toastTones[m.tone ?? "neutral"]
            )}
          >
            <RToast.Title className="font-ui text-14 font-medium text-text">{m.title}</RToast.Title>
            {m.description ? (
              <RToast.Description className="mt-1 font-ui text-13 text-muted">
                {m.description}
              </RToast.Description>
            ) : null}
            {m.traceId ? (
              <p className="mt-2 font-mono text-12 text-subtle">
                trace <span>{m.traceId}</span>
              </p>
            ) : null}
            <RToast.Close
              aria-label={dismissLabel ?? t("dismiss")}
              className={cn("absolute top-2 end-2 rounded-sm p-1 text-subtle hover:text-text", focusRing)}
            >
              <span aria-hidden="true">✕</span>
            </RToast.Close>
          </RToast.Root>
        ))}
        <RToast.Viewport className="fixed bottom-0 end-0 z-50 m-4 flex w-88 max-w-[calc(100vw-2rem)] flex-col gap-2" />
      </RToast.Provider>
    </ToastContext.Provider>
  );
}

/* -------------------------------------------------------------------------- */
/* CommandBar (⌘K) — docs/07 §3                                                */
/* -------------------------------------------------------------------------- */

export interface CommandItem {
  id: string;
  label: string;
  /** Group heading, e.g. "Entities", "Actions", "Docs". */
  group?: string;
  hint?: string;
  onSelect: () => void;
}

export interface CommandBarProps {
  items: CommandItem[];
  placeholder?: string;
  /** Accessible name for the palette. */
  label?: string;
  /** Shown when nothing matched. */
  emptyLabel?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Set when `items` come from a search the caller runs itself. Local filtering
   *  is then skipped — a server that already matched knows more than
   *  `label.includes()` does (it reads fields the label never shows). */
  onQueryChange?: (query: string) => void;
}

/**
 * Rows split into the blocks the caller asked for, in the caller's order — a
 * run of the same `group` is one block, and the same name appearing again later
 * starts a second one. Relevance order is the caller's answer; regrouping would
 * quietly overrule it.
 */
export function groupCommandItems(
  items: readonly CommandItem[]
): { name: string | null; items: CommandItem[] }[] {
  const blocks: { name: string | null; items: CommandItem[] }[] = [];
  for (const item of items) {
    const name = item.group ?? null;
    const last = blocks[blocks.length - 1];
    if (last && last.name === name) last.items.push(item);
    else blocks.push({ name, items: [item] });
  }
  return blocks;
}

/**
 * Global palette. Opens on ⌘K / Ctrl-K when uncontrolled. Results are a plain
 * listbox of buttons: native tab order and Enter already do the right thing.
 */
export function CommandBar({
  items,
  placeholder,
  label,
  emptyLabel,
  open,
  onOpenChange,
  onQueryChange
}: CommandBarProps) {
  const t = useUiText();
  const search = placeholder ?? t("commandSearch");
  const palette = label ?? t("commandPalette");
  const empty = emptyLabel ?? t("commandEmpty");
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = React.useCallback(
    (next: boolean) => {
      setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange]
  );
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listId = React.useId();
  // Where the reader was before ⌘K: the palette has no trigger of its own for
  // Radix to return focus to, so it went to <body> on close.
  const before = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(!isOpen);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, setOpen]);

  React.useEffect(() => {
    if (isOpen) {
      before.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    } else {
      // A palette reopened on yesterday's query answers the wrong question.
      setQuery("");
    }
  }, [isOpen]);

  const q = query.trim().toLowerCase();
  const results = onQueryChange || !q ? items : items.filter((i) => i.label.toLowerCase().includes(q));
  const blocks = groupCommandItems(results);
  const flat = blocks.flatMap((block) => block.items);
  const current = Math.min(active, Math.max(flat.length - 1, 0));
  React.useEffect(() => setActive(0), [query, items.length]);

  const choose = (item: CommandItem | undefined) => {
    if (!item) return;
    item.onSelect();
    setOpen(false);
  };

  // A listbox driven from its input (WAI-ARIA combobox): arrows move the
  // active option, Enter takes it. Before this, arrows did nothing and Enter
  // did nothing — a palette that needed a mouse or a dozen Tabs.
  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const last = flat.length - 1;
    const move = (to: number) => {
      e.preventDefault();
      setActive(to);
      document.getElementById(`${listId}-${to}`)?.scrollIntoView({ block: "nearest" });
    };
    if (e.key === "ArrowDown") move(current >= last ? 0 : current + 1);
    else if (e.key === "ArrowUp") move(current <= 0 ? last : current - 1);
    else if (e.key === "Home" && e.ctrlKey) move(0);
    else if (e.key === "End" && e.ctrlKey) move(last);
    else if (e.key === "Enter") {
      e.preventDefault();
      choose(flat[current]);
    }
  };

  return (
    <RDialog.Root open={isOpen} onOpenChange={setOpen}>
      <RDialog.Portal>
        <RDialog.Overlay className={overlayScrim} />
        <RDialog.Content
          onCloseAutoFocus={(event) => {
            if (!before.current?.isConnected) return;
            event.preventDefault();
            before.current.focus();
          }}
          aria-label={palette}
          className="fixed top-24 start-1/2 z-50 w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 rounded-lg border border-border bg-surface-2 text-start shadow-raised rtl:translate-x-1/2"
        >
          <RVisuallyHidden.Root>
            <RDialog.Title>{palette}</RDialog.Title>
            <RDialog.Description>{search}</RDialog.Description>
          </RVisuallyHidden.Root>
          <div className="border-b border-border p-3">
            <Input
              autoFocus
              role="combobox"
              aria-expanded={flat.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              {...(flat.length ? { "aria-activedescendant": `${listId}-${current}` } : {})}
              onKeyDown={onInputKey}
              value={query}
              onChange={(e) => {
                setQuery(e.currentTarget.value);
                onQueryChange?.(e.currentTarget.value);
              }}
              placeholder={search}
              aria-label={search}
            />
          </div>
          <ul id={listId} className="max-h-96 overflow-y-auto p-2" role="listbox" aria-label={palette}>
            {blocks.map((block, index) => (
              <li
                key={`${block.name ?? ""}-${index}`}
                {...(block.name ? { role: "group", "aria-label": block.name } : { role: "presentation" })}
              >
                {/* An eyebrow, so "Approvals the screen" and "Approvals the
                    record" are told apart without either row having to explain
                    itself. */}
                {block.name ? (
                  <span className="eyebrow block px-3 pb-1 pt-3">
                    {block.name}
                  </span>
                ) : null}
                {block.items.map((item) => (
                  // The row is the option: a button wrapped in a separate
                  // role="option" would be a focusable thing inside a
                  // non-focusable one, which is how a listbox stops making
                  // sense to a screen reader (axe: nested-interactive).
                  <button
                    key={item.id}
                    id={`${listId}-${flat.indexOf(item)}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={flat.indexOf(item) === current}
                    onMouseMove={() => setActive(flat.indexOf(item))}
                    onClick={() => choose(item)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-sm px-3 py-2 text-start font-ui text-14 text-muted",
                      "hover:text-text aria-selected:bg-surface-3 aria-selected:text-text",
                      focusRing
                    )}
                  >
                    <span>{item.label}</span>
                    {item.hint ? <span className="font-mono text-12 text-subtle">{item.hint}</span> : null}
                  </button>
                ))}
              </li>
            ))}
            {results.length === 0 ? (
              <li className="px-3 py-6 text-center font-ui text-13 text-subtle">{empty}</li>
            ) : null}
          </ul>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
