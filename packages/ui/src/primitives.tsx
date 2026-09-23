/**
 * Constellation primitives — docs/07 §2 "Core".
 *
 * Every style here uses CSS logical properties (Tailwind `ps-/pe-/ms-/me-/
 * start-/end-/border-s/text-start`). No physical-direction utility appears in
 * this package; `src/ui.test.ts` enforces it so RTL is structural, not a patch.
 */
import * as React from "react";
import {
  Avatar as RAvatar,
  Checkbox as RCheckbox,
  Label as RLabel,
  Progress as RProgress,
  RadioGroup as RRadioGroup,
  Select as RSelect,
  Separator as RSeparator,
  Slot as RSlot,
  Switch as RSwitch,
  Tabs as RTabs
} from "radix-ui";
import { cn, focusRing } from "./cn.js";

/* -------------------------------------------------------------------------- */
/* Button                                                                      */
/* -------------------------------------------------------------------------- */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ControlSize = "sm" | "md" | "lg";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-contrast hover:bg-accent-hover",
  secondary: "bg-surface-2 text-text border border-border hover:bg-surface-3",
  ghost: "text-muted hover:bg-surface-2 hover:text-text",
  danger: "bg-danger text-danger-contrast hover:opacity-90"
};

// Hit targets ≥ 40px at default density (docs/07 §5); `sm` is for compact ops rows.
const buttonSizes: Record<ControlSize, string> = {
  sm: "h-8 px-3 text-13",
  md: "h-10 px-4 text-14",
  lg: "h-11 px-5 text-16"
};

export interface ButtonProps extends React.ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant;
  size?: ControlSize;
  /** Render the child element instead of a <button> (links, menu items). */
  asChild?: boolean;
  /** Marks the action as busy; also sets aria-busy and blocks activation. */
  loading?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  asChild = false,
  loading = false,
  className,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? RSlot.Slot : "button";
  return (
    <Comp
      {...props}
      // ponytail: Slot forwards these to the child element; typing them once here.
      {...(asChild ? {} : { type: props.type ?? "button" })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-ui font-medium",
        "transition-colors duration-150 ease-out",
        "disabled:pointer-events-none disabled:opacity-50",
        focusRing,
        buttonVariants[variant],
        buttonSizes[size],
        className
      )}
    >
      {children}
    </Comp>
  );
}

/**
 * Icon-only button. Requires `label` — it becomes the accessible name.
 * Navigation never uses this (see ./nav.tsx): nav labels are always visible.
 */
export interface IconButtonProps extends Omit<ButtonProps, "asChild" | "children"> {
  label: string;
  children: React.ReactNode;
}

export function IconButton({ label, size = "md", className, children, ...props }: IconButtonProps) {
  return (
    <Button
      {...props}
      size={size}
      aria-label={label}
      title={label}
      className={cn("aspect-square px-0", className)}
    >
      <span aria-hidden="true">{children}</span>
    </Button>
  );
}

/* -------------------------------------------------------------------------- */
/* Field — label / hint / error wiring shared by every control                 */
/* -------------------------------------------------------------------------- */

interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FieldContext = React.createContext<FieldContextValue | null>(null);

/**
 * Props a control should spread onto its own element so it inherits the
 * Field's id and aria wiring. Safe to call outside a Field (returns nothing).
 */
export function useFieldControl(): {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  required?: boolean;
} {
  const ctx = React.useContext(FieldContext);
  if (!ctx) return {};
  return {
    id: ctx.id,
    ...(ctx.describedBy ? { "aria-describedby": ctx.describedBy } : {}),
    ...(ctx.invalid ? { "aria-invalid": true as const } : {}),
    ...(ctx.required ? { required: true } : {})
  };
}

export interface FieldProps extends Omit<React.ComponentPropsWithRef<"div">, "id"> {
  label: string;
  /** Hide the label visually but keep it for assistive tech. Never omit it. */
  labelHidden?: boolean;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  id?: string;
}

export function Field({
  label,
  labelHidden = false,
  hint,
  error,
  required = false,
  id,
  className,
  children,
  ...props
}: FieldProps) {
  const auto = React.useId();
  const fieldId = id ?? auto;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const ctx = React.useMemo<FieldContextValue>(
    () => ({ id: fieldId, describedBy, invalid: Boolean(error), required }),
    [fieldId, describedBy, error, required]
  );

  return (
    <div {...props} className={cn("flex flex-col gap-1.5 text-start", className)}>
      <RLabel.Root
        htmlFor={fieldId}
        className={cn(
          "font-ui text-13 font-medium text-muted",
          labelHidden && "sr-only absolute h-px w-px overflow-hidden"
        )}
      >
        {label}
        {required ? (
          <span className="ms-1 text-danger" aria-hidden="true">
            *
          </span>
        ) : null}
      </RLabel.Root>
      <FieldContext.Provider value={ctx}>{children}</FieldContext.Provider>
      {hint ? (
        <p id={hintId} className="font-ui text-12 text-subtle">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="font-ui text-12 text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Input / Textarea                                                            */
/* -------------------------------------------------------------------------- */

const controlBase =
  "rounded-md border border-border bg-surface-1 font-ui text-14 text-text " +
  "placeholder:text-subtle transition-colors duration-150 ease-out " +
  "hover:border-border-strong aria-invalid:border-danger " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/**
 * A control fills its column unless the screen sized it. `cn` joins classes, it
 * does not resolve conflicts (cn.ts), so a `w-full` baked into `controlBase`
 * silently beat every `className="w-56"` a screen passed — which is why the
 * module filter strips rendered one full-width control per row instead of a
 * single line. Yield the default width when the caller brought their own.
 */
const widthFrom = (className?: string) =>
  /(^|\s)(w-|flex-1)/.test(className ?? "") ? undefined : "w-full";

const inputSizes: Record<ControlSize, string> = {
  sm: "h-8 px-2.5 text-13",
  md: "h-10 px-3",
  lg: "h-11 px-3.5 text-16"
};

export interface InputProps extends Omit<React.ComponentPropsWithRef<"input">, "size" | "prefix"> {
  size?: ControlSize;
  /** Renders inside the control on the inline-start edge (an icon, a currency). */
  prefix?: React.ReactNode;
  /** Renders inside the control on the inline-end edge (a unit, a clear button). */
  suffix?: React.ReactNode;
}

export function Input({ size = "md", prefix, suffix, className, ...props }: InputProps) {
  const field = useFieldControl();
  // A text adornment is as wide as its text: "ZAR" under a fixed ps-9 sat on
  // top of the value. Reserve its width in ch plus the inset either side.
  const reserve = (adornment: React.ReactNode) =>
    typeof adornment === "string" && adornment.length > 1 ? `calc(${adornment.length}ch + 1.25rem)` : undefined;
  const control = (
    <input
      {...field}
      {...props}
      style={{
        ...(reserve(prefix) ? { paddingInlineStart: reserve(prefix) } : {}),
        ...(reserve(suffix) ? { paddingInlineEnd: reserve(suffix) } : {}),
        ...props.style
      }}
      className={cn(
        controlBase,
        widthFrom(className),
        inputSizes[size],
        focusRing,
        prefix ? "ps-9" : undefined,
        suffix ? "pe-9" : undefined,
        className
      )}
    />
  );
  if (!prefix && !suffix) return control;
  return (
    <div className="relative flex items-center">
      {prefix ? (
        <span
          className="pointer-events-none absolute start-3 text-subtle"
          aria-hidden="true"
        >
          {prefix}
        </span>
      ) : null}
      {control}
      {suffix ? (
        <span className="pointer-events-none absolute end-3 text-subtle" aria-hidden="true">
          {suffix}
        </span>
      ) : null}
    </div>
  );
}

export function Textarea({ className, ...props }: React.ComponentPropsWithRef<"textarea">) {
  const field = useFieldControl();
  return (
    <textarea
      {...field}
      {...props}
      className={cn(
        controlBase,
        widthFrom(className),
        "min-h-24 p-3 leading-normal",
        focusRing,
        className
      )}
    />
  );
}

/**
 * DatePicker. ponytail: the native control is keyboard-accessible, localised,
 * and free — a JS calendar is 40KB we do not need. `calendar` selects the
 * display calendar (docs/07 §2 asks for a Hijri display option); browsers that
 * honour it render Hijri, the value stays ISO either way.
 */
export interface DatePickerProps extends Omit<React.ComponentPropsWithRef<"input">, "type"> {
  calendar?: "gregory" | "islamic-umalqura";
  withTime?: boolean;
}

export function DatePicker({ calendar, withTime = false, className, ...props }: DatePickerProps) {
  const field = useFieldControl();
  return (
    <input
      {...field}
      {...props}
      type={withTime ? "datetime-local" : "date"}
      lang={calendar ? `${props.lang ?? "en"}-u-ca-${calendar}` : props.lang}
      className={cn(controlBase, widthFrom(className), inputSizes.md, focusRing, className)}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Select                                                                      */
/* -------------------------------------------------------------------------- */

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * Radix reserves the empty string on `Select.Root`: `value === ""` *is* "nothing
 * selected" — it is what raises the placeholder — so a `Select.Item` may not use
 * it. Radix says so on the console, and the row could never read as chosen even
 * when it is.
 *
 * Screens still need a row that means "no filter" ("All", "System default"), so
 * the empty option travels to Radix under this sentinel and is decoded back to
 * "" on the way out: the value a call site passes in, reads back from
 * `onValueChange`, and submits through `name`, is "" throughout. The sentinel
 * never leaves this file, which is the point — a call site cannot reintroduce
 * the bug by writing `{ value: "" }`, because that is the supported spelling.
 */
const EMPTY_SENTINEL = "__lyra_select_empty";

/** "" → sentinel. Every value handed to a `Select.Item` goes through here. */
export const toSelectValue = (value: string): string =>
  value === "" ? EMPTY_SENTINEL : value;

/** sentinel → "". Every value Radix hands back goes through here. */
export const fromSelectValue = (value: string): string =>
  value === EMPTY_SENTINEL ? "" : value;

export interface SelectProps {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  size?: ControlSize;
  name?: string;
  /** Accessible name when the Select is not wrapped in a Field. */
  "aria-label"?: string;
  className?: string;
}

export function Select({
  options,
  value,
  defaultValue,
  onValueChange,
  // Not "Select…": this package has no catalogue, and an English word baked
  // into a shared control is a string no tenant can translate (CLAUDE.md §7).
  // The ellipsis alone reads the same in every locale — a screen that wants
  // words passes them, as the filter strips and the statement form do.
  placeholder = "…",
  disabled,
  size = "md",
  name,
  className,
  ...aria
}: SelectProps) {
  const field = useFieldControl();
  // Held here rather than in Radix so the sentinel is a rendering detail: what
  // Radix sees selected — and so what `name` submits — is always the decoded
  // value, "" included. Picking the empty row therefore clears the field
  // instead of submitting a made-up token.
  const [chosen, setChosen] = React.useState(defaultValue ?? "");
  const current = value ?? chosen;
  // Encoded on the way in as well as on the items, or "" matches no item and
  // Radix reads it as "nothing chosen" — the trigger then renders the "…"
  // placeholder over a row the screen has actually selected. Only when an
  // empty row exists: a Select without one uses "" to mean unset, and handing
  // Radix a sentinel it cannot resolve blanks the trigger instead.
  const hasEmptyOption = options.some((o) => o.value === "");
  return (
    <RSelect.Root
      value={hasEmptyOption ? toSelectValue(current) : current}
      onValueChange={(next) => {
        const decoded = fromSelectValue(next);
        setChosen(decoded);
        onValueChange?.(decoded);
      }}
      {...(disabled !== undefined ? { disabled } : {})}
    >
      <RSelect.Trigger
        {...field}
        {...aria}
        className={cn(
          controlBase,
          widthFrom(className),
          inputSizes[size],
          focusRing,
          "inline-flex items-center justify-between gap-2 text-start",
          className
        )}
      >
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon aria-hidden="true">▾</RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          sideOffset={4}
          className="z-50 min-w-(--radix-select-trigger-width) overflow-hidden rounded-md border border-border bg-surface-2 shadow-glow"
        >
          <RSelect.Viewport className="p-1">
            {options.map((o) => (
              <RSelect.Item
                key={o.value}
                value={toSelectValue(o.value)}
                {...(o.disabled ? { disabled: true } : {})}
                className={cn(
                  "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-2 text-14 text-muted",
                  "data-[highlighted]:bg-surface-3 data-[highlighted]:text-text data-[highlighted]:outline-none",
                  "data-[state=checked]:text-accent data-[disabled]:opacity-40"
                )}
              >
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
      {/* Radix's own hidden <select> (`name` on Root) cannot be trusted to
          carry the value into a form submission: it is keyed by the set of
          options its items register, those items live inside the portalled
          Content, and closing the popup unmounts them — so the element
          remounts around the moment a user clicks Save. J-O1 caught it on CI
          posting `status=intake` while the trigger read "Failed" (run
          31426014087): the screen agrees with the user, the database does not.
          `current` is already the decoded truth this component renders from,
          so submit that and nothing else — and, like the native control it
          replaces, submit nothing at all while disabled. */}
      {name !== undefined && !disabled ? <input type="hidden" name={name} value={current} /> : null}
    </RSelect.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* Checkbox / Radio / Switch                                                   */
/* -------------------------------------------------------------------------- */

export interface CheckboxProps
  extends Omit<React.ComponentPropsWithoutRef<typeof RCheckbox.Root>, "children"> {
  label: string;
}

export function Checkbox({ label, className, id, ...props }: CheckboxProps) {
  const auto = React.useId();
  const boxId = id ?? auto;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <RCheckbox.Root
        {...props}
        id={boxId}
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-sm border border-border bg-surface-1",
          "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-contrast",
          focusRing
        )}
      >
        <RCheckbox.Indicator className="text-12 leading-none">✓</RCheckbox.Indicator>
      </RCheckbox.Root>
      <RLabel.Root htmlFor={boxId} className="font-ui text-14 text-muted">
        {label}
      </RLabel.Root>
    </div>
  );
}

export interface RadioGroupProps
  extends Omit<React.ComponentPropsWithoutRef<typeof RRadioGroup.Root>, "children"> {
  options: SelectOption[];
  /** Accessible name for the group. */
  label: string;
}

export function RadioGroup({ options, label, className, ...props }: RadioGroupProps) {
  return (
    <RRadioGroup.Root {...props} aria-label={label} className={cn("flex flex-col gap-2", className)}>
      {options.map((o) => {
        const id = `${label}-${o.value}`;
        return (
          <div key={o.value} className="flex items-center gap-2">
            <RRadioGroup.Item
              value={o.value}
              id={id}
              {...(o.disabled ? { disabled: true } : {})}
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-orbit border border-border bg-surface-1",
                "data-[state=checked]:border-accent",
                focusRing
              )}
            >
              <RRadioGroup.Indicator className="size-2.5 rounded-orbit bg-accent" />
            </RRadioGroup.Item>
            <RLabel.Root htmlFor={id} className="font-ui text-14 text-muted">
              {o.label}
            </RLabel.Root>
          </div>
        );
      })}
    </RRadioGroup.Root>
  );
}

export interface SwitchProps extends React.ComponentPropsWithoutRef<typeof RSwitch.Root> {
  label: string;
}

export function Switch({ label, className, id, ...props }: SwitchProps) {
  const auto = React.useId();
  const switchId = id ?? auto;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <RSwitch.Root
        {...props}
        id={switchId}
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-orbit border border-border bg-surface-3",
          "transition-colors duration-150 ease-out data-[state=checked]:bg-accent",
          focusRing
        )}
      >
        {/* translate-x is mirrored by the RTL-aware `rtl:` variant below */}
        <RSwitch.Thumb className="block size-4 rounded-orbit bg-star-100 transition-transform duration-150 ease-out data-[state=checked]:translate-x-4 rtl:data-[state=checked]:-translate-x-4" />
      </RSwitch.Root>
      <RLabel.Root htmlFor={switchId} className="font-ui text-14 text-muted">
        {label}
      </RLabel.Root>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Slider                                                                      */
/* -------------------------------------------------------------------------- */

export interface SliderProps
  extends Omit<React.ComponentPropsWithRef<"input">, "type" | "value" | "onChange" | "size" | "min" | "max" | "step"> {
  value: number;
  min: number;
  max: number;
  step?: number;
  /**
   * What assistive tech should say instead of the bare number — "AED 28,000",
   * "45 days". WCAG 2.2 AA: a value only meaningful next to a currency symbol
   * on screen is meaningless read out without one.
   */
  valueText?: string;
  /** Label for the typed fallback. It is a second control and needs its own name. */
  numberLabel: string;
  onValueChange: (value: number) => void;
}

/**
 * A range with a typed fallback beside it.
 *
 * ponytail: `<input type="range">`, not a JS slider. The native control is
 * already keyboard-operable (arrows, Home/End, Page Up/Down), already exposes
 * role=slider with its value, already drags under a thumb on a phone, and
 * already reverses itself under `direction: rtl` — four requirements and no
 * dependency. The parts the platform does not give are the two here: a
 * value announced in words, and a box to type into when dragging is not on
 * offer (a switch control, a tremor, a narrow screen).
 *
 * The Field's label belongs to the range, so the number input takes a derived
 * id and its own `aria-label` rather than a second copy of the field's.
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  valueText,
  numberLabel,
  onValueChange,
  className,
  disabled,
  ...props
}: SliderProps) {
  const field = useFieldControl();
  const auto = React.useId();
  const numberId = `${field.id ?? auto}-number`;
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const commit = (raw: string) => {
    if (raw === "") return; // mid-edit, not a value yet
    const n = Number(raw);
    if (Number.isFinite(n)) onValueChange(clamp(n));
  };

  return (
    <div className={cn("flex items-center gap-3", widthFrom(className), className)}>
      <input
        {...field}
        {...props}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        {...(valueText ? { "aria-valuetext": valueText } : {})}
        onChange={(e) => commit(e.target.value)}
        // h-11 is the 44px target size AA asks for; the visual track is thinner
        // than the box you can grab. accent-color paints thumb and fill from the
        // tenant's brand token, so no custom pseudo-elements are needed.
        style={{ accentColor: "var(--accent)" }}
        className={cn("h-11 min-w-0 flex-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50", focusRing)}
      />
      <input
        id={numberId}
        aria-label={numberLabel}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => commit(e.target.value)}
        className={cn(controlBase, "h-11 w-28 shrink-0 px-2.5 text-end tabular-nums", focusRing)}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Card / Badge / Avatar / Skeleton / Separator / Tabs                         */
/* -------------------------------------------------------------------------- */

export interface CardProps extends Omit<React.ComponentPropsWithRef<"section">, "title"> {
  /** Surfaces get lighter as they rise — docs/07 §1 elevation language. */
  elevation?: "flat" | "raised" | "floating";
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  padded?: boolean;
}

/* Horizon carries depth on the hairline, not the shadow: `--elev`/`--elev2`
   are a whisper in daylight and literally `none` after dark (ADR-0031). */
const cardElevation = {
  flat: "bg-surface-1",
  raised: "bg-surface-2 shadow-elev",
  floating: "bg-surface-3 shadow-elev2"
} as const;

export function Card({
  elevation = "flat",
  title,
  description,
  actions,
  padded = true,
  className,
  children,
  ...props
}: CardProps) {
  const headingId = React.useId();
  return (
    <section
      {...props}
      {...(title ? { "aria-labelledby": headingId } : {})}
      className={cn("rounded-md border border-border text-start", cardElevation[elevation], className)}
    >
      {title || actions ? (
        <header
          className={cn(
            "flex items-start justify-between gap-4 border-b border-border",
            padded ? "px-4 py-3" : "pb-3"
          )}
        >
          <div className="min-w-0">
            {title ? (
              <h3 id={headingId} className="font-display text-14 font-semibold tracking-[0.01em] text-text">
                {title}
              </h3>
            ) : null}
            {description ? (
              <p className="mt-1 font-ui text-13 text-subtle">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      {/* A card whose body is conditional (`{rows.length ? <ul/> : null}`) used
          to keep its padding anyway, and the empty band under the header read
          as a half-loaded screen. No children, no body. */}
      {children == null || children === false ? null : (
        <div className={padded ? "p-4" : undefined}>{children}</div>
      )}
    </section>
  );
}

export interface PageHeaderProps {
  /** Small static label above the headline, e.g. a category name. */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Caller renders its own router `<Link>` — this package doesn't depend on react-router. */
  back?: React.ReactNode;
  /** Trailing row below the description, e.g. a reference/id line. */
  meta?: React.ReactNode;
  className?: string;
}

export function PageHeader({ eyebrow, title, description, back, meta, className }: PageHeaderProps) {
  return (
    <header className={cn("flex flex-col", back ? "gap-2" : "gap-1", className)}>
      {back}
      {eyebrow ? (
        <span className="font-mono text-12 uppercase tracking-[0.14em] text-subtle">{eyebrow}</span>
      ) : null}
      <h1 className="font-serif text-22 leading-[1.2] text-text">{title}</h1>
      {description ? <p className="max-w-prose font-ui text-13 text-muted">{description}</p> : null}
      {meta}
    </header>
  );
}

export type BadgeTone = "neutral" | "accent" | "success" | "danger" | "warning" | "info";

const badgeTones: Record<BadgeTone, string> = {
  neutral: "border-border bg-surface-2 text-muted",
  accent: "border-accent/40 bg-accent/10 text-accent",
  success: "border-success/40 bg-success/10 text-success",
  danger: "border-danger/40 bg-danger/10 text-danger",
  warning: "border-warning/40 bg-warning/10 text-warning",
  info: "border-info/40 bg-info/10 text-info"
};

export interface BadgeProps extends React.ComponentPropsWithRef<"span"> {
  tone?: BadgeTone;
  size?: "sm" | "md";
  /** A leading status dot in the tone colour. */
  dot?: boolean;
}

export function Badge({ tone = "neutral", size = "md", dot = false, className, children, ...props }: BadgeProps) {
  return (
    <span
      {...props}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-orbit border font-ui font-medium",
        size === "sm" ? "px-2 py-0.5 text-12" : "px-2.5 py-1 text-12",
        badgeTones[tone],
        className
      )}
    >
      {dot ? <span className="size-1.5 rounded-orbit bg-current" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/** Tag is Badge under a second name — docs/07 §2 lists "Tag/Badge". */
export const Tag = Badge;

export interface AvatarProps {
  name: string;
  src?: string;
  size?: ControlSize;
  className?: string;
}

const avatarSizes: Record<ControlSize, string> = { sm: "size-6 text-12", md: "size-8 text-12", lg: "size-10 text-14" };

export function Avatar({ name, src, size = "md", className }: AvatarProps) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join("");
  return (
    <RAvatar.Root className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-orbit bg-surface-3", avatarSizes[size], className)}>
      {src ? <RAvatar.Image src={src} alt={name} className="size-full object-cover" /> : null}
      <RAvatar.Fallback className="font-ui font-semibold text-muted" delayMs={src ? 300 : 0}>
        <span aria-label={name}>{initials}</span>
      </RAvatar.Fallback>
    </RAvatar.Root>
  );
}

export function Skeleton({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return (
    <div
      {...props}
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-surface-3/60", className)}
    />
  );
}

export function Separator({ className, ...props }: React.ComponentPropsWithoutRef<typeof RSeparator.Root>) {
  return <RSeparator.Root {...props} className={cn("bg-border data-[orientation=horizontal]:h-px data-[orientation=vertical]:w-px", className)} />;
}

export interface TabItem {
  value: string;
  label: string;
  content: React.ReactNode;
  disabled?: boolean;
}

export interface TabsProps extends Omit<React.ComponentPropsWithoutRef<typeof RTabs.Root>, "children"> {
  items: TabItem[];
  /** Accessible name for the tab list. */
  label: string;
}

export function Tabs({ items, label, className, ...props }: TabsProps) {
  return (
    <RTabs.Root {...props} className={cn("flex flex-col gap-4", className)}>
      <RTabs.List aria-label={label} className="flex gap-1 border-b border-border">
        {items.map((t) => (
          <RTabs.Trigger
            key={t.value}
            value={t.value}
            {...(t.disabled ? { disabled: true } : {})}
            className={cn(
              "-mb-px border-b-2 border-transparent px-3 py-2 font-ui text-14 text-subtle",
              "hover:text-text data-[state=active]:border-accent data-[state=active]:text-text",
              "disabled:opacity-40",
              focusRing
            )}
          >
            {t.label}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {items.map((t) => (
        <RTabs.Content key={t.value} value={t.value} className={focusRing}>
          {t.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  );
}

/** Determinate progress bar used by meters (confidence, budget, match rate). */
export function ProgressBar({
  value,
  label,
  tone = "accent",
  className
}: {
  value: number;
  label: string;
  tone?: BadgeTone;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  const fill: Record<BadgeTone, string> = {
    neutral: "bg-muted",
    accent: "bg-accent",
    success: "bg-success",
    danger: "bg-danger",
    warning: "bg-warning",
    info: "bg-info"
  };
  return (
    <RProgress.Root
      value={pct}
      aria-label={label}
      className={cn("h-1.5 w-full overflow-hidden rounded-orbit bg-surface-3", className)}
    >
      <RProgress.Indicator
        className={cn("h-full transition-[inline-size] duration-250 ease-out", fill[tone])}
        style={{ inlineSize: `${pct}%` }}
      />
    </RProgress.Root>
  );
}
