import { expect, it } from "vitest";
import {
  activityDisclosure,
  activityDisclosureOnRunning,
  activityDisclosureToggle,
} from "../src/tools/activity-open";

it("opens a tool row when its status becomes running unless the user collapsed it", () => {
  expect(activityDisclosure(true)).toEqual({ open: true, collapsedByUser: false });
  expect(activityDisclosure(false)).toEqual({ open: false, collapsedByUser: false });

  const waiting = activityDisclosure(false);
  const running = activityDisclosureOnRunning(waiting, true);
  expect(running).toEqual({ open: true, collapsedByUser: false });
  expect(activityDisclosureOnRunning(waiting, false)).toBe(waiting);
  expect(activityDisclosureOnRunning(running, false)).toBe(running);

  const collapsed = activityDisclosureToggle(running);
  expect(collapsed).toEqual({ open: false, collapsedByUser: true });
  expect(activityDisclosureOnRunning(collapsed, true)).toBe(collapsed);

  const reopened = activityDisclosureToggle(collapsed);
  expect(reopened).toEqual({ open: true, collapsedByUser: false });
  expect(activityDisclosureOnRunning(reopened, true)).toBe(reopened);
});
