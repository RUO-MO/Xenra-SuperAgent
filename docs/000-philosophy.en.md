# 000 Philosophy

[中文](000-philosophy.md) · English

Xenra-SuperAgent is a proactive coding agent, and also a discipline for working with one. The code, the panel and this document all come down to one principle:

**Take as little human attention as possible, and give as much value as possible.**

That principle is not a slogan; it decides whether a behaviour happens and whether a message is sent. A notice that only repeats a result the reader already has is a net cost in attention. The agent therefore stays quiet unless asked, works to a reviewable result once asked, and then returns to the original conversation with a sentence a person can act on.

## What this asks of the agent

- **It acts only when asked, or under a written condition.** A request must address the agent explicitly and come either from a person on an allowed list or from a case the admission table admits for that receiving scope; any other message becomes a candidate only through the admission table and the accept mode. Work nobody asked for needs a rule the team wrote, and starts in a mode that only records what the agent would have done.
- **It speaks only when a person must act or can use a result.** An accept is confirmed in one sentence naming the change; progress stays internal while the work runs. It writes again when a result can be reviewed, when it needs a decision, or when the work genuinely cannot go on. Messages are short: an instant message holds at most one hundred words, link labels and destinations included.
- **It asks one concrete question at a time.** The question travels in a structured field and returns to the conversation where the person wrote it, rather than sitting inside a report for someone to find.
- **It stops by impact, not by effort.** A local change goes as far as a reviewable result; a change that breaks a public interface, reassigns module responsibility or needs a design decision stops with a clear question, leaving a draft that states honestly what is unfinished.
- **It reports honestly.** A draft is marked unfinished, a failure is reported as a failure, a UI change without real before-and-after evidence is not ready, and a limit is never bypassed or a success faked to avoid asking.

## What this asks of the design

- **Few concepts.** The model holds only what the domain itself needs — Source, Trigger, Thread, Policy, Eval, Decision, Mandate, Ticket, Assignment, Input, Report, Attention — plus their implementations for concrete Sources. A business need becomes an attribute of one of them or prompt text the agent follows; the design does not add a concept for it.
- **Few settings.** Where one value suits almost every team, a default replaces the setting; behaviour a team describes in words is prompt text, not a setting. Only what code must enforce — allowed lists, rules, accept mode, concurrency, the execution directory and the prepare command — becomes a setting.
- **A panel that shows only what needs a person.** It lists first what waits for a person. A healthy state takes no space, a number appears only when it changes what the supervisor does, and any count equals the length of the list it links to.
- **Documents read in order.** Each numbered document builds only on the ones before it, so a reader never meets a concept that has not been introduced.

## Responsibility

The agent comments, opens pull requests and messages people under accounts your team sees every day. Every message it sends costs your colleagues' attention, and you are responsible for it. The more the agent can do, the more care its operator owes the team:

- **Start narrow.** Begin with a short allowed list and with proactive work only recorded. Widen both once what the agent would have done looks right.
- **Tune for less noise.** When the agent is noisy, make its prompts shorter and stricter, or pause it. Do not add more messages to explain the noise.
- **Do not use it to produce volume.** Mass pull requests, broadcast messages and busywork with no follow-up cost the team more than they give.
- **Own what it says.** Read what the agent posts in your name; when it is wrong, correct the prompt or the rule instead of apologising line by line afterwards.
- **Bound what it may decide alone.** Merging, approval and access are stated in prompt text and repository rules; by default a person merges every pull request.

The goal is the right help at the right time, and nothing at any other time.
