import { describe, expect, it } from "vitest";
import { en } from "@/src/i18n/en";
import { ru } from "@/src/i18n/ru";
import {
  duplicateReasonText,
  errorText,
  eventMessageText,
  plural,
  template,
} from "@/src/i18n/text";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Every leaf path of a dictionary, e.g. `errors.contentEmpty` or `dashboard.rules.0`. */
function leafPaths(value: Json, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => leafPaths(entry, `${prefix}.${index}`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      leafPaths(entry as Json, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [prefix];
}

function leaves(value: Json, prefix = ""): Array<[string, Json]> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => leaves(entry, `${prefix}.${index}`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      leaves(entry as Json, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [[prefix, value]];
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

describe("dictionaries", () => {
  it("have exactly the same keys", () => {
    expect(leafPaths(ru as unknown as Json).sort()).toEqual(
      leafPaths(en as unknown as Json).sort(),
    );
  });

  it("never ship an empty string", () => {
    const empty = leaves(en as unknown as Json)
      .concat(leaves(ru as unknown as Json))
      .filter(([, value]) => typeof value === "string" && value.trim() === "")
      .map(([path]) => path);
    expect(empty).toEqual([]);
  });

  it("use the same placeholders in every language", () => {
    const byPath = new Map(leaves(ru as unknown as Json));
    const mismatched = leaves(en as unknown as Json)
      .filter(([, value]) => typeof value === "string")
      .filter(([path, value]) => {
        const translated = byPath.get(path);
        return (
          typeof translated === "string" &&
          placeholders(value as string).join(",") !== placeholders(translated).join(",")
        );
      })
      .map(([path]) => path);
    expect(mismatched).toEqual([]);
  });

  it("translate the codes the server actions send, instead of echoing them", () => {
    // If a redirect ever starts sending an untranslated code, the UI falls back
    // to `errors.unknown`; this keeps the two lists honest.
    for (const code of ["contentEmpty", "budgetExceeded", "noteEmpty", "unknownStatus"]) {
      expect(ru.errors[code as keyof typeof ru.errors]).not.toBe(
        en.errors[code as keyof typeof en.errors],
      );
    }
  });
});

describe("errorText", () => {
  it("renders a known code in the requested language", () => {
    expect(errorText(en, "noteEmpty")).toBe(en.errors.noteEmpty);
    expect(errorText(ru, "noteEmpty")).toBe(ru.errors.noteEmpty);
  });

  it("fills placeholders", () => {
    expect(errorText(en, "contentTooLong", { limit: 20_000 })).toBe(
      "Content exceeds 20000 characters.",
    );
  });

  it("degrades to a generic message for an unknown code", () => {
    expect(errorText(ru, "Lead not found.")).toBe(ru.errors.unknown);
  });

  it("renders nothing when there is no code", () => {
    expect(errorText(en, null)).toBeNull();
    expect(errorText(en, "")).toBeNull();
  });
});

describe("duplicateReasonText", () => {
  it("localizes a reworded-repost overlap", () => {
    expect(duplicateReasonText(en, "overlapSameAuthor", 91)).toBe(
      "same author, 91% text overlap",
    );
    expect(duplicateReasonText(ru, "overlapSameAuthor", 91)).toBe(
      "тот же автор, совпадение текста 91%",
    );
  });

  it("ignores an unknown reason rather than printing it", () => {
    expect(duplicateReasonText(en, "same author, 91% text overlap")).toBeNull();
    expect(duplicateReasonText(en, null)).toBeNull();
  });
});

describe("eventMessageText", () => {
  const deduplicated = {
    message: "Duplicate candidate ignored (same author, 91% text overlap)",
    metadata: { reason: "overlapSameAuthor", percent: 91, similarity: 0.91 },
  };

  it("re-renders a deduplicated sighting in the owner's language", () => {
    expect(eventMessageText(en, deduplicated)).toBe(
      "Duplicate candidate ignored (same author, 91% text overlap)",
    );
    expect(eventMessageText(ru, deduplicated)).toBe(
      "Дублирующий пост пропущен (тот же автор, совпадение текста 91%)",
    );
  });

  it("leaves every other stored log line alone", () => {
    const note = { message: "Called them, they want a call back Friday", metadata: null };
    expect(eventMessageText(ru, note)).toBe(note.message);
    // A reason code we do not know about must not blank the line out.
    const unknown = { message: "Duplicate candidate ignored (?) ", metadata: { reason: "??" } };
    expect(eventMessageText(ru, unknown)).toBe(unknown.message);
  });
});

describe("text helpers", () => {
  it("leaves unknown placeholders untouched", () => {
    expect(template("a {b} c {d}", { b: 1 })).toBe("a 1 c {d}");
  });

  const forms = { one: "лид", few: "лида", many: "лидов" };
  const englishForms = { one: "lead", few: "leads", many: "leads" };

  it("English distinguishes only one from the rest", () => {
    expect(plural("en", 1, englishForms)).toBe("lead");
    expect(plural("en", 0, englishForms)).toBe("leads");
    expect(plural("en", 3, englishForms)).toBe("leads");
    expect(plural("en", 5, englishForms)).toBe("leads");
  });

  it("Russian picks the 2–4 form, not just singular/plural", () => {
    expect(plural("ru", 1, forms)).toBe("лид");
    expect(plural("ru", 2, forms)).toBe("лида");
    expect(plural("ru", 4, forms)).toBe("лида");
    expect(plural("ru", 5, forms)).toBe("лидов");
    expect(plural("ru", 0, forms)).toBe("лидов");
  });

  it("Russian keeps the special cases at 11–14 and 21", () => {
    expect(plural("ru", 11, forms)).toBe("лидов");
    expect(plural("ru", 12, forms)).toBe("лидов");
    expect(plural("ru", 14, forms)).toBe("лидов");
    expect(plural("ru", 21, forms)).toBe("лид");
    expect(plural("ru", 22, forms)).toBe("лида");
    expect(plural("ru", 111, forms)).toBe("лидов");
  });

  it("both dictionaries carry a few-form for every plural string", () => {
    for (const [locale, dictionary] of Object.entries({ en, ru })) {
      expect(dictionary.leads.countFew, locale).toBeTruthy();
      expect(dictionary.leads.filtersActiveFew, locale).toBeTruthy();
    }
    // The Russian forms must actually differ — a copy-paste of `countMany` would
    // compile and pass key-parity, yet read wrong on every list of 2–4 leads.
    expect(ru.leads.countFew).not.toBe(ru.leads.countMany);
    expect(ru.leads.filtersActiveFew).not.toBe(ru.leads.filtersActiveMany);
  });
});
