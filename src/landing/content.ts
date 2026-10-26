export const LANDING_TITLE = "mockbot · Your own agent that actually does things";

export const LANDING_DESCRIPTION =
  "A personal agent with its own computer. It plans, browses, writes the code and works in your apps, and it asks before anything risky.";

export const SOURCE_URL = "https://github.com/siddhak711/mockbot";

export type CrownColor = "violet" | "blue" | "green" | "pink" | "teal";
export type CrownState = "idle" | "thinking" | "working" | "done";

export type DayEvent = {
  time: string;
  title: string;
  detail: string;
  status: "Done" | "Needs you" | "Running";
  state: CrownState;
  color: CrownColor;
  tone: "p1" | "p2" | "p3" | "p4" | "p5";
};

export const DAY_EVENTS: DayEvent[] = [
  {
    time: "07:30",
    title: "Morning brief",
    detail: "Calendar, inbox and weather in one note",
    status: "Done",
    state: "idle",
    color: "violet",
    tone: "p1",
  },
  {
    time: "09:12",
    title: "Fare watch",
    detail: "JFK → SFO dropped to $276. Hold it?",
    status: "Needs you",
    state: "thinking",
    color: "blue",
    tone: "p4",
  },
  {
    time: "11:40",
    title: "Expenses",
    detail: "Six receipts matched and filed in Drive",
    status: "Done",
    state: "done",
    color: "green",
    tone: "p2",
  },
  {
    time: "14:05",
    title: "Fix the date bug",
    detail: "Tests pass in the sandbox. PR drafted",
    status: "Running",
    state: "working",
    color: "teal",
    tone: "p4",
  },
  {
    time: "16:30",
    title: "Reply to Alex",
    detail: "Draft written in your tone",
    status: "Needs you",
    state: "idle",
    color: "pink",
    tone: "p5",
  },
  {
    time: "19:00",
    title: "Dinner for four",
    detail: "7:45 at Lupa is open. Book it?",
    status: "Needs you",
    state: "thinking",
    color: "violet",
    tone: "p3",
  },
];

export const STEPS = [
  "Opened Drive · “Q2 plan”",
  "Pulled the four goals",
  "Opened Gmail · new draft",
  "Wrote six lines in your tone",
];

export const APPS = ["Gmail", "Calendar", "Drive", "GitHub", "Notion", "Slack"];

export const MEMORIES = [
  ["Aisle seats, always", "memory"],
  ["Short emails, no exclamation marks", "memory"],
  ["Weekday brief at 7:30", "routine"],
  ["Watch JFK → SFO under $280", "routine"],
] as const;

export const FRAMES = [
  ["0:00", "Read the ask"],
  ["0:04", "Made a plan"],
  ["0:09", "Opened Drive"],
  ["0:15", "Pulled 4 goals"],
  ["0:22", "Wrote the draft"],
  ["0:31", "Asked to send"],
] as const;

export const NEXT_ITEMS = [
  {
    title: "Plan first",
    detail: "Read and edit the plan before a single tool runs.",
    tone: "p1",
    icon: "M4 6h16M4 12h10M4 18h6",
  },
  {
    title: "Checks itself",
    detail: "A last look at its own work before it says done.",
    tone: "p2",
    icon: "M5 12l4 4 10-10",
  },
  {
    title: "Spends less",
    detail: "Each step goes to the cheapest model that can do it well.",
    tone: "p3",
    icon: "M12 3a9 9 0 100 18 9 9 0 000-18zM9 10c0-1.2 1.3-2 3-2s3 .8 3 2-1.3 1.6-3 2-3 .8-3 2 1.3 2 3 2 3-.8 3-2M12 6v2M12 16v2",
  },
  {
    title: "Site tools",
    detail: "Saved scripts replay on a site, no model needed.",
    tone: "p4",
    icon: "M8 6l-5 6 5 6M16 6l5 6-5 6",
  },
  {
    title: "Run replay",
    detail: "Scrub a finished run like a video.",
    tone: "p5",
    icon: "M6 4l12 8-12 8z",
  },
] as const;

export const FAQS = [
  [
    "What is mockbot?",
    "A personal agent with its own computer. You give it a goal, it plans the steps and uses a browser, code and your apps to finish.",
  ],
  [
    "Will it do things without asking?",
    "Reading and searching happen on their own. Sending, editing, buying and deleting wait for your yes in the chat.",
  ],
  [
    "Which models does it run?",
    "Open weights models. You can pick a different model for each agent.",
  ],
  [
    "Where does my data live?",
    "Secrets for your apps stay on the server and never go into a prompt. Every memory is visible, and you can delete any of them.",
  ],
  [
    "What can it connect to?",
    "Popular apps from a catalog in one click, or any MCP server by pasting its address.",
  ],
  ["What happens when I join?", "You get one email when your spot opens. That is the only email."],
  [
    "Can I read the code?",
    "Yes. The agent loop, memory, connectors and sandbox are all in the public repository.",
  ],
] as const;

export function statusClass(status: DayEvent["status"]): string {
  return status.split(" ")[0].toLowerCase();
}
