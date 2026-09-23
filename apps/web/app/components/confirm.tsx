import * as React from "react";
import { Button, Dialog, useUiLocale, type ButtonProps } from "@lyra/ui";
import { translator } from "../i18n";

/**
 * A submit button that asks first.
 *
 * Replaces `window.confirm()`, which is the browser's own chrome: it never
 * translates, never mirrors under RTL, cannot carry the tenant's brand, and is
 * suppressed outright inside some embedded webviews — where the guard on a
 * consequential action (CLAUDE.md §4) would silently disappear.
 *
 * The ask is on the button, not the form, so a form with several submitters
 * keeps working: confirming re-submits with the pressed button as the
 * submitter, which is how these forms carry their `intent`.
 */
export interface ConfirmButtonProps extends Omit<ButtonProps, "onClick"> {
  /** What the actor is agreeing to. It is the dialog's body. */
  message: string;
  /** Runs before the ask; return false to stop without opening the dialog. */
  guard?: () => boolean;
}

export function ConfirmButton({ message, guard, children, ...props }: ConfirmButtonProps) {
  const t = translator(useUiLocale());
  const [asking, setAsking] = React.useState(false);
  const trigger = React.useRef<HTMLButtonElement>(null);

  return (
    <>
      <Button
        {...props}
        ref={trigger}
        onClick={(event) => {
          event.preventDefault();
          // Native validation first, as a real submit would: no point asking
          // about an action the form is going to refuse to send.
          if (event.currentTarget.form?.reportValidity() === false) return;
          if (guard && !guard()) return;
          setAsking(true);
        }}
      >
        {children}
      </Button>
      <Dialog
        open={asking}
        onOpenChange={setAsking}
        size="sm"
        title={t("common.confirmTitle")}
        description={message}
        closeLabel={t("common.cancel")}
        returnFocus={trigger}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              data-confirm=""
              variant={props.variant === "danger" ? "danger" : "primary"}
              onClick={() => {
                setAsking(false);
                const button = trigger.current;
                button?.form?.requestSubmit(button);
              }}
            >
              {/* The button names the act — "Delete", "Reject" — the way the
                  trigger did; a bare "Continue" made the reader re-read the
                  question to know what they were agreeing to. */}
              {typeof children === "string" ? children : t("common.confirmGo")}
            </Button>
          </>
        }
      />
    </>
  );
}
