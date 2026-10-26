export type ActivityDisclosure = {
  open: boolean;
  collapsedByUser: boolean;
};

export function activityDisclosure(running: boolean): ActivityDisclosure {
  return { open: running, collapsedByUser: false };
}

/** A call that starts running opens itself, unless this row was closed by hand. */
export function activityDisclosureOnRunning(
  current: ActivityDisclosure,
  running: boolean,
): ActivityDisclosure {
  if (!running || current.open || current.collapsedByUser) return current;
  return { open: true, collapsedByUser: false };
}

export function activityDisclosureToggle(current: ActivityDisclosure): ActivityDisclosure {
  const open = !current.open;
  return { open, collapsedByUser: !open };
}
