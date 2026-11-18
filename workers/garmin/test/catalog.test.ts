import { describe, it, expect } from "vitest";
import { localDate, addDays, daysBetween } from "../src/garmin/dates";
import { DATASETS, dataset, hasData, hasValue } from "../src/garmin/catalog";

describe("dates", () => {
  it("localDate / addDays / daysBetween", () => {
    expect(localDate("Asia/Tokyo", new Date("2026-10-27T18:30:00Z"))).toBe("2026-10-28");
    expect(localDate("UTC", new Date("2026-10-27T18:30:00Z"))).toBe("2026-10-27");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-10-01", "2026-10-28")).toBe(27);
  });
});

describe("catalog", () => {
  it("paths", () => {
    expect(new Set(DATASETS.map((d) => d.id)).size).toBe(19);
    expect(dataset("steps").path("2026-10-01", "2026-10-28", "2026-10-28")).toBe("/usersummary-service/stats/steps/daily/2026-10-01/2026-10-28");
    expect(dataset("cycle_day").path("2026-10-27", "2026-10-27", "2026-10-28")).toContain("todayDate=2026-10-28");
    expect(dataset("weight").path("2025-10-28", "2026-10-28", "2026-10-28")).toContain("includeAll=true");
    expect(dataset("weight_goal").path("", "", "2026-10-28")).toBe("/goal-service/goal/user/effective/weightgoal/2025-10-28/2026-10-28");
  });
  it("hasValue / hasData", () => {
    expect(hasValue(0)).toBe(true); expect(hasValue({})).toBe(false); expect(hasValue([])).toBe(false);
    expect(hasValue(false)).toBe(true); expect(hasValue("")).toBe(false); expect(hasValue(null)).toBe(false);
    expect(hasData({ calendarDate: "2023-10-28", userProfileId: 1, includesWellnessData: false })).toBe(false);
    expect(hasData({ calendarDate: "2026-10-27", totalSteps: 0 })).toBe(true);
    expect(hasData({ startTimestampGMT: "x", endTimestampLocal: "y", wellnessStartTimeGmt: "z" })).toBe(false);
  });
  it("items", () => {
    expect(dataset("sleep").items([{ calendarDate: "2026-10-27", sleepTimeSeconds: 1 }, { calendarDate: "2026-10-26", sleepTimeSeconds: null, deviceRemCapable: true }], "2026-10-26", "2026-10-27"))
      .toEqual([{ key: "2026-10-27", day: "2026-10-27", data: expect.objectContaining({ sleepTimeSeconds: 1 }) }]);
    expect(dataset("daily_summary_v2").items({ data: [{ calendarDate: "2026-10-27", heartRate: { restingValue: 58 } }] }, "2026-10-27", "2026-10-27")[0].key).toBe("2026-10-27");
    expect(dataset("body_battery").items([{ date: "2026-10-27", charged: 40 }], "2026-10-27", "2026-10-27")[0].day).toBe("2026-10-27");
    expect(dataset("weight").items({ dailyWeightSummaries: [{ summaryDate: "2026-10-20", latestWeight: { weight: 82300 } }] }, "2026-10-01", "2026-10-28")[0].key).toBe("2026-10-20");
    expect(dataset("hrv").items(null, "2026-10-28", "2026-10-28")).toEqual([]);
    expect(dataset("hrv").items({ hrvSummary: { weeklyAvg: 40 } }, "2026-10-28", "2026-10-28")[0]).toMatchObject({ key: "2026-10-28", day: "2026-10-28" });
    expect(dataset("profile").items({ timeZone: "Asia/Tokyo" }, "", "")[0]).toMatchObject({ key: "current", day: null });
    expect(dataset("profile").items({}, "", "")).toEqual([]);
  });
  it("wellness_activity groups by day", () => {
    const r = dataset("wellness_activity").items([
      { calendarDate: "2026-10-27T00:00:00.0", steps: 5 },
      { calendarDate: { localDate: "2026-10-27T10:00" }, steps: 0 },
      { calendarDate: "2026-10-26", userProfileId: 1 },
      { calendarDate: "2026-10-25", steps: 1 },
    ], "2026-10-25", "2026-10-27");
    expect(r.map((i) => i.key)).toEqual(["2026-10-27", "2026-10-25"]);
    expect(r[0].data).toHaveLength(2);
  });
});
