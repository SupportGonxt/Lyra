import { describe, expect, it } from "vitest";
import { STATEMENT_FORMATS, detectStatementFormat, parseStatement } from "./statements.js";

// docs/27 F16: "No cash application and no bank statement import — CAMT/MT940/OFX
// absent; `ledger-recon.tsx:521` requires hand-pasted JSON." docs/19 §6 names
// four reconciliation processes whose input is a counterparty's own file; until
// this module existed there was no way to get one into the product except by
// hand-typing its contents as JSON, which is not an import, it is a dare.
//
// Every parser here answers the same question — what lines does this file
// contain — and returns the `StatementLine[]` `reconcile()` already takes. The
// reconciliation engine is untouched: a parser is a translation, not a policy.

const CAMT = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>STMT-2026-06</Id>
      <Acct><Id><IBAN>AE070331234567890123456</IBAN></Id></Acct>
      <Ntry>
        <NtryRef>NTRY-1</NtryRef>
        <Amt Ccy="AED">1250.50</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2026-06-03</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <Refs><EndToEndId>POL-88431</EndToEndId></Refs>
          <RmtInf><Ustrd>Premium settlement Falcon</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <NtryRef>NTRY-2</NtryRef>
        <Amt Ccy="AED">40.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-06-04</Dt></BookgDt>
        <NtryDtls><TxDtls><RmtInf><Ustrd>Bank charges</Ustrd></RmtInf></TxDtls></NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

const MT940 = `:20:STMT26061
:25:AE070331234567890123456
:28C:00123/001
:60F:C260601AED10000,00
:61:2606030603C1250,50NTRFPOL-88431//NTRY-1
:86:Premium settlement Falcon
:61:2606040604D40,00NCHGCHARGES//NTRY-2
:86:Bank charges
:62F:C260630AED11210,50
-`;

const OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>AED
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260603120000
<TRNAMT>1250.50
<FITID>NTRY-1
<NAME>Falcon Insurance
<MEMO>POL-88431 premium settlement
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260604
<TRNAMT>-40.00
<FITID>NTRY-2
<MEMO>Bank charges
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe("the format is detected from the file, not from its name", () => {
  it("recognises all three", () => {
    expect(detectStatementFormat(CAMT)).toBe("camt053");
    expect(detectStatementFormat(MT940)).toBe("mt940");
    expect(detectStatementFormat(OFX)).toBe("ofx");
  });

  it("says so plainly when it recognises nothing", () => {
    // An upload nobody can read must fail loudly on the way in. A parser that
    // shrugs and returns no lines reads, to the controller, as "the bank sent
    // an empty statement" — which is the one thing it certainly did not do.
    expect(() => parseStatement("just some text")).toThrowError(
      expect.objectContaining({ detail: expect.stringMatching(/not a statement/i) })
    );
    expect(detectStatementFormat("just some text")).toBeNull();
  });

  it("publishes the formats it can read, so a UI need not hard-code them", () => {
    expect([...STATEMENT_FORMATS]).toEqual(["camt053", "mt940", "ofx"]);
  });
});

describe("every format yields the same statement", () => {
  it.each([
    ["camt053", CAMT],
    ["mt940", MT940],
    ["ofx", OFX]
  ])("%s", (format, text) => {
    const parsed = parseStatement(text);
    expect(parsed.format).toBe(format);
    expect(parsed.lines).toHaveLength(2);

    const [credit, debit] = parsed.lines;
    // Minor units, integer, signed: money in is positive, money out negative.
    // A statement that reported both as positive would reconcile a refund
    // against a receipt and call it a match.
    expect(credit?.amountMinor).toBe(125_050);
    expect(credit?.currency).toBe("AED");
    expect(credit?.ref).toBe("NTRY-1");
    expect(credit?.postedAt).toBe(Date.UTC(2026, 5, 3));
    expect(credit?.description).toMatch(/falcon|premium/i);
    expect(credit?.ourRef).toBe("POL-88431");

    expect(debit?.amountMinor).toBe(-4_000);
    expect(debit?.ref).toBe("NTRY-2");
    expect(debit?.postedAt).toBe(Date.UTC(2026, 5, 4));
  });
});

describe("the parsers refuse what they cannot represent", () => {
  it("refuses a CAMT entry with no amount rather than importing a zero", () => {
    const broken = CAMT.replace('<Amt Ccy="AED">1250.50</Amt>', "");
    expect(() => parseStatement(broken)).toThrowError(
      expect.objectContaining({ detail: expect.stringMatching(/amount/i) })
    );
  });

  it("refuses an MT940 line whose amount is not a number", () => {
    const broken = MT940.replace("C1250,50NTRF", "Cnot-a-numberNTRF");
    expect(() => parseStatement(broken)).toThrowError(
      expect.objectContaining({ detail: expect.stringMatching(/amount/i) })
    );
  });

  it("refuses a statement with no lines at all", () => {
    const empty = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Id>X</Id></Stmt></BkToCstmrStmt></Document>`;
    expect(() => parseStatement(empty)).toThrowError(
      expect.objectContaining({ detail: expect.stringMatching(/no lines/i) })
    );
  });

  it("does not lose the fils: 1250.50 is 125050, never 125049", () => {
    // Float arithmetic on money is how a reconciliation acquires a one-fil
    // variance nobody can explain. Parse the decimal as text.
    const odd = CAMT.replace("1250.50", "1250.07").replace("40.00", "0.01");
    const parsed = parseStatement(odd);
    expect(parsed.lines[0]?.amountMinor).toBe(125_007);
    expect(parsed.lines[1]?.amountMinor).toBe(-1);
  });

  it("reads a two-decimal currency with three decimals stated", () => {
    // Some Gulf currencies (KWD, BHD, OMR) are three-decimal. The parser keeps
    // whatever precision the file states rather than rounding to two, because
    // the minor unit is the currency's, not the parser's.
    const kwd = CAMT.replace('Ccy="AED">1250.50', 'Ccy="KWD">1250.500');
    expect(parseStatement(kwd).lines[0]?.amountMinor).toBe(1_250_500);
  });
});

describe("OFX parsing does not backtrack catastrophically (CodeQL js/polynomial-redos)", () => {
  // Both regressions are shaped the same way: a lazy or overlapping quantifier
  // that only blows up when the overall match ultimately FAILS, because that
  // is what forces the engine to exhaust every way of placing the ambiguous
  // part before giving up. A bounded-time assertion is the regression guard —
  // reintroducing either vulnerable pattern makes this test time out, not
  // just run slow.

  it("splits a run of unclosed <STMTTRN> tags in linear time", () => {
    // The vulnerable splitter was `<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|(?=<\/BANKTRANLIST>))`:
    // a lazy `[\s\S]*?` with three ways to stop, so a long run of tags that
    // never close gave the old regex exponentially many candidate stop points
    // before it found (or failed to find) a match at each start position.
    const body = "<STMTTRN>".repeat(4000);
    const ofx = `OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>${body}</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const started = Date.now();
    // badRequest()'s argument lands on AppError.detail, not .message (which
    // stays the fixed "Bad request" title) — assert on the property that
    // actually carries it.
    expect(() => parseStatement(ofx)).toThrow(expect.objectContaining({ detail: expect.stringMatching(/has no amount/) }));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("resolves a reference-shaped memo without exponential backtracking on a non-match", () => {
    // The vulnerable ref-finder was `[A-Z]{2,6}-[A-Z0-9-]*\d[A-Z0-9-]*`: the
    // two starred groups either side of the required digit share the same
    // character class, so a long run of one repeated member followed by a
    // character that can never complete the match forces the engine to try
    // every split point between the two groups before concluding failure.
    const memo = `ABC-${"0".repeat(20_000)}!`; // trailing "!" makes the whole token unmatchable
    const ofx = [
      "OFXHEADER:100",
      "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>",
      "<STMTTRN><TRNAMT>10.00<DTPOSTED>20260601<MEMO>",
      memo,
      "</STMTTRN>",
      "</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>"
    ].join("\n");
    const started = Date.now();
    const parsed = parseStatement(ofx);
    expect(Date.now() - started).toBeLessThan(1000);
    // No digit-bearing reference could be extracted from an unmatchable
    // token, so the line still parses — just without `ourRef`.
    expect(parsed.lines[0]?.ourRef).toBeUndefined();
  });
});

describe("what the reconciler gets", () => {
  it("hands back exactly the shape reconcile() takes, with no reconciliation done", () => {
    const parsed = parseStatement(CAMT);
    expect(parsed.currency).toBe("AED");
    expect(parsed.accountRef).toBe("AE070331234567890123456");
    for (const l of parsed.lines) {
      expect(typeof l.ref).toBe("string");
      expect(Number.isInteger(l.amountMinor)).toBe(true);
      expect(l.currency).toHaveLength(3);
    }
  });
});
