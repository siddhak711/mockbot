import {
  APPS,
  DAY_EVENTS,
  FAQS,
  FRAMES,
  MEMORIES,
  NEXT_ITEMS,
  SOURCE_URL,
  STEPS,
  statusClass,
  type DayEvent,
} from "../../src/landing/content";
import { CrownBot } from "./crown-bot";
import { LandingEffects } from "./landing-effects";
import { WaitlistForm } from "./waitlist-form";
import "./landing.css";

function DayCard({ event, hidden = false }: { event: DayEvent; hidden?: boolean }) {
  return (
    <article className={`ev ${event.tone}`} aria-hidden={hidden || undefined}>
      <header>
        <span className="t">{event.time}</span>
        <span className={`st ${statusClass(event.status)}`}>{event.status}</span>
      </header>
      <CrownBot color={event.color} state={event.state} size={44} />
      <b>{event.title}</b>
      <p>{event.detail}</p>
    </article>
  );
}

export function LandingPage() {
  return (
    <div className="daylight">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <nav id="daylight-nav">
        <a className="b" href="#top">
          <CrownBot size={28} />
          mockbot
        </a>
        <div className="l">
          <a href="#how">How it works</a>
          <a href="#replay">Replay</a>
          <a href="#faq">FAQ</a>
          <a href={SOURCE_URL}>Source</a>
        </div>
        <a className="c" href="#join">
          Join waitlist
        </a>
      </nav>
      <header className="hero w" id="top">
        <p className="eyebrow" data-r="">
          <i />
          Early access · opening in small waves
        </p>
        <h1 data-r="" style={{ ["--d" as string]: "80ms" }}>
          <span className="ln">
            Your own{" "}
            <span className="perch">
              agent
              <CrownBot className="hb" size={150} alt="mockbot" />
            </span>
          </span>
          <span className="ln">
            that <em>actually</em>
          </span>
          <span className="ln">does things.</span>
        </h1>
        <div className="hrow" data-r="" style={{ ["--d" as string]: "200ms" }}>
          <p className="lede">
            Give it a goal. It plans, opens the browser, writes the code and works in your apps
            until the job is done, and it checks with you before anything risky.
          </p>
          <div id="join">
            <WaitlistForm id="e1" />
          </div>
        </div>
      </header>
      <section className="day" aria-label="One day with mockbot">
        <div className="w dayhead">
          <span className="mono">A Tuesday, handled</span>
          <span className="mono">Hover to pause</span>
        </div>
        <div className="mask">
          <div className="track">
            {DAY_EVENTS.map((event) => (
              <DayCard key={event.time} event={event} />
            ))}
            {DAY_EVENTS.map((event) => (
              <DayCard key={`${event.time}-repeat`} event={event} hidden />
            ))}
          </div>
        </div>
      </section>
      <main id="main">
        <div className="w" id="how">
          <section className="ch">
            <div className="txt" data-r="">
              <span className="num">01</span>
              <h2>
                You ask once.
                <br />
                It does the steps.
              </h2>
              <p>
                It makes a plan, opens the tabs, reads the docs and writes the draft. You stay in
                the conversation, not in the busywork.
              </p>
            </div>
            <div className="card p1" data-r="" style={{ ["--d" as string]: "120ms" }}>
              <span className="clabel">Chat</span>
              <div className="thread">
                <div className="mm me">
                  Send Alex a short summary of our Q2 plan. Ask for feedback by Friday.
                </div>
                <ol className="steps">
                  {STEPS.map((step, index) => (
                    <li key={step} style={{ ["--i" as string]: index }}>
                      {step}
                    </li>
                  ))}
                </ol>
                <div className="mm reply">
                  <div className="who">
                    <CrownBot state="done" size={26} />
                    mockbot
                  </div>
                  Draft is ready in Gmail. Send it?
                </div>
              </div>
            </div>
          </section>
          <section className="ch">
            <div className="txt" data-r="">
              <span className="num">02</span>
              <h2>
                It asks before
                <br />
                anything risky.
              </h2>
              <p>
                Sending, buying, deleting, posting. It stops and shows you exactly what is about to
                happen. One tap to approve, one to change it.
              </p>
            </div>
            <div className="card p3" data-r="" style={{ ["--d" as string]: "120ms" }}>
              <span className="clabel">Approvals</span>
              <div className="stack">
                <div className="appr">
                  <div>
                    <b>Send to alex@northwind.co</b>
                    <span>“Q2 plan, feedback by Friday?”</span>
                  </div>
                  <div className="bt">
                    <button type="button">Edit</button>
                    <button type="button" className="y">
                      Send
                    </button>
                  </div>
                </div>
                <div className="appr">
                  <div>
                    <b>Book Lupa · Thu 7:45 PM · 4 people</b>
                    <span>No deposit. Free to cancel until noon.</span>
                  </div>
                  <div className="bt">
                    <button type="button">Edit</button>
                    <button type="button" className="y">
                      Book
                    </button>
                  </div>
                </div>
              </div>
              <CrownBot className="peek" state="thinking" size={170} />
            </div>
          </section>
          <section className="ch">
            <div className="txt" data-r="">
              <span className="num">03</span>
              <h2>
                Its own computer.
                <br />
                Your apps.
              </h2>
              <p>
                Code and a browser run in a sandbox you can watch. Connect your accounts from a
                one-click catalog. Under the hood: its own agent loop on open-weights models.
              </p>
            </div>
            <div className="card p2" data-r="" style={{ ["--d" as string]: "120ms" }}>
              <span className="clabel">Sandbox</span>
              <div className="term">
                <div className="tbar">
                  <i />
                  <i />
                  <i />
                  <span>sandbox</span>
                </div>
                <code>
                  <span className="p">$</span> pytest -q
                  <br />
                  <span className="dim">........</span> <span className="g">8 passed</span> in 1.4s
                  <br />
                  <span className="p">$</span> git push origin fix/date-parse
                  <br />
                  <span className="g">✓</span> Draft PR opened
                  <span className="caret" />
                </code>
              </div>
              <div className="chips">
                {APPS.map((app) => (
                  <span key={app}>{app}</span>
                ))}
                <span className="add">+ any MCP server</span>
              </div>
            </div>
          </section>
          <section className="ch">
            <div className="txt" data-r="">
              <span className="num">04</span>
              <h2>
                It remembers you.
                <br />
                It keeps the routine.
              </h2>
              <p>
                Preferences carry across chats, and you can edit any of them. Routines run on a
                schedule, and a small team of agents can pass work along in one thread.
              </p>
            </div>
            <div className="card p4" data-r="" style={{ ["--d" as string]: "120ms" }}>
              <span className="clabel">Memory · routines</span>
              <ul className="mem">
                {MEMORIES.map(([fact, kind]) => (
                  <li key={fact}>
                    {fact}
                    <span>{kind}</span>
                  </li>
                ))}
              </ul>
              <div className="crewmini">
                <CrownBot state="working" size={52} />
                <CrownBot color="blue" state="thinking" size={52} />
                <CrownBot color="green" state="idle" size={52} />
                <CrownBot color="pink" state="done" size={52} />
                <span>Mockbot hands the fare to Scout, Scout books, Inkwell writes the note.</span>
              </div>
            </div>
          </section>
        </div>
        <section className="band" id="replay">
          <div className="w">
            <div className="bandhead" data-r="">
              <div>
                <span className="soon">Coming soon</span>
                <h2>Rewind any run.</h2>
              </div>
              <p>
                Every run is recorded step by step. Scrub back to see what it saw, what it clicked
                and why.
              </p>
            </div>
            <div className="rp" data-r="" style={{ ["--d" as string]: "120ms" }}>
              <div className="rptop">
                <span className="mono">run · Q2 email · 31s · 6 steps</span>
                <span className="mono">1×</span>
              </div>
              <div className="frames">
                {FRAMES.map(([time, label], index) => (
                  <div key={time} className="fr" style={{ ["--i" as string]: index }}>
                    <span className="mono">{time}</span>
                    <b>{label}</b>
                  </div>
                ))}
              </div>
              <div className="bar">
                <i className="fill" />
                <i className="head" />
              </div>
            </div>
          </div>
        </section>
        <section className="w nextsec">
          <div className="secthead" data-r="">
            <span className="num">Next</span>
            <h2>On the bench.</h2>
          </div>
          <div className="next">
            {NEXT_ITEMS.map((item, index) => (
              <article
                key={item.title}
                className={`nx ${item.tone}`}
                data-r=""
                style={{ ["--d" as string]: `${index * 70}ms` }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d={item.icon} />
                </svg>
                <div>
                  <span className="mono">0{index + 1}</span>
                  <b>{item.title}</b>
                  <p>{item.detail}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
        <section className="w faq" id="faq">
          <div className="secthead" data-r="">
            <span className="num">FAQ</span>
            <h2>Good to know.</h2>
          </div>
          <div className="qs">
            {FAQS.map(([question, answer], index) => (
              <details key={question} open={index === 0 || undefined}>
                <summary>
                  {question}
                  <i />
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="w end">
          <div className="crew" aria-hidden="true">
            <CrownBot size={84} />
            <CrownBot color="blue" state="done" size={84} />
            <CrownBot color="green" state="working" size={84} />
            <CrownBot color="pink" size={84} />
            <CrownBot color="teal" state="thinking" size={84} />
          </div>
          <h2 data-r="">
            Meet your
            <br />
            first agent.
          </h2>
          <div className="endrow" data-r="" style={{ ["--d" as string]: "120ms" }}>
            <p>
              Early access opens in small waves. Leave your email and you will get one note when
              your spot is ready.
            </p>
            <WaitlistForm id="e2" />
          </div>
        </section>
      </main>
      <footer className="w">
        <span className="fb">
          <CrownBot size={22} />© 2026 Siddha Kanthi
        </span>
        <div>
          <a href={SOURCE_URL}>Source</a>
          <a href="#">Privacy</a>
          <a href="#">Terms</a>
        </div>
      </footer>
      <LandingEffects />
    </div>
  );
}
