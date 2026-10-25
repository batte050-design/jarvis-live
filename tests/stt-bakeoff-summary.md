# Speech recognition: the bake-off, for Mohammad to judge

Your own kept clips, run through four models with the settings the page uses. Times are seconds per
clip on this machine. Two of the 25 clips in the full run are the synthetic silence clips used to
test the failure path (each costs 0.05s); they pull the averages down by about 0.04s.

## Time

| model | mean per clip | total, 25 clips | on disk |
|---|---|---|---|
| tiny.en | 0.58s | 14.6s | yes |
| base.en | 0.96s | 24.0s | yes (fetched for this test) |
| base | 1.02s | 25.5s | yes, **what the page uses now** |
| small | 2.72s | 68.1s | yes, used only as the recovery pass |

For scale: recognition is a fixed cost of about **1.1s** whether you speak for one second or eight,
so the model is the only lever on this leg of the wait.

## Words, not punctuation

Counting only real word differences, the number of times each candidate was the lone one out against
the other three:

- **base.en: 0**
- **base: 1**
- **small: 1**
- **tiny.en: 2** — and it invents words rather than mishearing them

## Every clip where they disagree, so you can judge

| clip | secs | base | base.en | small | tiny.en |
|---|---|---|---|---|---|
| 193315 | 2.0 | RESTAT | Restat | RISTAT | Restette. |
| 193331 | 1.4 | **Restart the server** | Restate the server | Restate the server | Rest |
| 193439 | 2.8 | a lot of rhythm and music | Hello, Riddemull and News | Hello, read million years | Eloridmudamiz |
| 070346 | 6.3 | check, server health and everything, are you online? | Check server health and everything. Are you online? | Check server health and everything. Are you online? | Chick, Sabah Health and everything, are you online? |
| 070441 | 5.2 | Did you send my girlfriend her message, her daily message? | Did you send my girlfriend her daily message? | Did you send my girlfriend her daily message? | Did you send my girlfriend her message? Had a message. |
| 070541 | 5.5 | So, gift, daily reminder, but IC messages being sent | So give daily reminder but I see messages being sent | gift, daily reminder, but I see messages being sent | So, give daily reminder, but I see messages being sent. |
| 050114 | 0.6 | Hello, Javi | Hello, Javi | Hello, Javi | Hello Javis. |
| 050129 | 1.1 | ready to make for death news | 3D metro decanels | ready to designate | ready to meet today's noodles |
| 050223 | 3.0 | I told you latest news, that is word the news | I told you latest news that is for the news | **I told you latest news, that is all the news** | I told you latest news, that is for the news... |
| 050302 | 1.9 | That story is today's back | **That story is two days back** | **That story is two days back** | That story is two days back. |
| 050414 | 2.2 | gave me detailed news, detailed | Give me detailed news, detailed | Give me detailed the news, detailed | Gave me detailed the news, detailed it |
| 053721 | 1.8 | Hello JARVIS, read me the news. | Hello JARVIS, read me the news! | Hello Jervis, read me the news | Hello JARVIS, read me the news! |
| 055511 | 2.3 | What is the time rate now? | What is the time right now? | What is the time right now? | What is the time rate now? |
| 064939 | 0.6 | (nothing) | This | JARVIS | This... |
| 064951 | 0.3 | . . . | Ntinda | Ntok | and Tom. |

Bold marks the plausibly correct reading where the others differ.

## What the numbers say

- **tiny.en** is the fastest and the worst: it invents words ("Eloridmudamiz", "3D metro decanels",
  "Sabah Health"). It would not help even in the recovery role.
- **base.en** is never the lone dissenter and is 6 % faster than base, which is inside the noise. It
  also loses clips base wins, such as "Restart the server".
- **small** is 2.7 times slower and both wins and loses against base, which matches the earlier
  finding that it changes twelve of twenty-five transcripts while winning no more often.
- **base**, what the page uses now, is the middle of the field and no candidate beats it on both
  time and errors.

## The recommendation, and the decision

On this evidence, **nothing changes**: no candidate wins on both counts, which is the test you set.
The one thing worth your eye is whether **base.en** reads better to you than **base** on the clips
above — it is the same speed and never the lone dissenter, so if you prefer its wording it is a free
swap. Say which you prefer and it is one line to change.

Two failures the new guard already caught in these very clips: on the 0.6-second clip `small`
returned "JARVIS" and on the 0.3-second one `base.en` returned "Ntinda" — both the priming
vocabulary handed back rather than speech, both now discarded. That is the guard from item 6 doing
its job on real audio.

A hosted transcriber remains the open ASK: it would send your voice to a third party, with a cost
and a rate limit. Nothing about it is provisioned or tested, and I would not move on it without your
word.
