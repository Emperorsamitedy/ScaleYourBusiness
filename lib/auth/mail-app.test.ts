import { describe, expect, it } from "vitest";
import { mailAppFor } from "./mail-app";

describe("mailAppFor", () => {
  it("offers Gmail for Google's consumer domains", () => {
    expect(mailAppFor("owner@gmail.com")?.name).toBe("Gmail");
    expect(mailAppFor("Owner@GoogleMail.com")?.name).toBe("Gmail");
  });

  it("offers Outlook for Microsoft's consumer domains, national ones included", () => {
    expect(mailAppFor("owner@hotmail.com")?.name).toBe("Outlook");
    expect(mailAppFor("owner@outlook.hu")?.name).toBe("Outlook");
    expect(mailAppFor("owner@live.co.uk")?.name).toBe("Outlook");
  });

  it("offers nothing for a business domain, which could be hosted anywhere", () => {
    expect(mailAppFor("owner@fernhill-ceramics.example")).toBeNull();
    expect(mailAppFor("not an email")).toBeNull();
  });
});
