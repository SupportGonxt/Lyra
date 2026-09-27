import { describe, expect, it } from "vitest";
import { autonomyPermitsSend, checkAutoReply } from "./orbit-auto-reply.js";

const CONTEXT = [
  "Customer Amina Haddad, locale en, 1 active policies.",
  "Policy POL-2201: status active, premium 2400 AED, cover 2025-11-02 to 2026-11-02.",
  "customer: How much will my renewal be?"
];

describe("checkAutoReply", () => {
  it("passes a grounded reply in the conversation's language", () => {
    expect(checkAutoReply("The premium on the book today is 2400 AED; a colleague will confirm the renewal.", CONTEXT, "en")).toEqual({
      ok: true,
      why: null
    });
  });

  it("refuses a number the context did not give", () => {
    const r = checkAutoReply("Your renewal is 2650 AED.", CONTEXT, "en");
    expect(r.ok).toBe(false);
    expect(r.why).toBe("ungrounded");
  });

  it("refuses a claim that something was done, in English and Arabic", () => {
    expect(checkAutoReply("I have cancelled your policy.", CONTEXT, "en").why).toBe("action_claim");
    expect(checkAutoReply("Your refund has been processed.", CONTEXT, "en").why).toBe("action_claim");
    expect(checkAutoReply("You are now covered.", CONTEXT, "en").why).toBe("action_claim");
    expect(checkAutoReply("تم إلغاء وثيقتك.", CONTEXT, "ar").why).toBe("action_claim");
    expect(checkAutoReply("قمت بإضافة السائق.", CONTEXT, "ar").why).toBe("action_claim");
  });

  it("does not mistake an acknowledgement or a promise to follow up for an action", () => {
    expect(checkAutoReply("Your message has been received and a colleague will reply here.", CONTEXT, "en").ok).toBe(true);
    expect(checkAutoReply("I can pass your cancellation request to a colleague.", CONTEXT, "en").ok).toBe(true);
  });

  it("refuses a guarantee of cover", () => {
    expect(checkAutoReply("Your application is guaranteed to be accepted.", CONTEXT, "en").why).toBe("compliance");
    expect(checkAutoReply("القبول مضمون لطلبك.", CONTEXT, "ar").why).toBe("compliance");
  });

  it("refuses a reply in the other language", () => {
    expect(checkAutoReply("Your claim is under review.", CONTEXT, "ar").why).toBe("language");
    expect(checkAutoReply("مطالبتك قيد المراجعة.", CONTEXT, "en").why).toBe("language");
  });

  it("refuses an empty or overlong reply", () => {
    expect(checkAutoReply("   ", CONTEXT, "en").why).toBe("empty");
    expect(checkAutoReply("word ".repeat(400), CONTEXT, "en").why).toBe("too_long");
  });
});

describe("autonomyPermitsSend", () => {
  it("lets only the two acting rungs send", () => {
    expect(autonomyPermitsSend("suggest")).toBe(false);
    expect(autonomyPermitsSend("act_with_approval")).toBe(false);
    expect(autonomyPermitsSend("act_within_limits")).toBe(true);
    expect(autonomyPermitsSend("autonomous")).toBe(true);
  });

  it("fails closed on a level on no ladder", () => {
    expect(autonomyPermitsSend("suggest_only")).toBe(false);
    expect(autonomyPermitsSend("")).toBe(false);
  });
});
