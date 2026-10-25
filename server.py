#!/usr/bin/env python3
"""JARVIS Live — streaming text, streaming voice, ears, interruption, and a real brain.

Design (three lines):
  voice in      browser speech recognition, with the interrupt decided on the phone
  voice out     the cloned voice, streamed a sentence at a time, played as it lands
  behind it     a fast front layer that answers instantly, and Hermes delegated the
                real work, whose result is spoken into the same conversation when it lands

The page owns all audio. This server owns the two model links and nothing else.
"""
import base64
import json
import os
import pathlib
import queue
import signal
import random
import re
import secrets
import hmac
import glob
import hashlib
import numpy as np
import datetime
import zoneinfo
import asyncio
import threading
import time
import mimetypes
import urllib.parse
import urllib.request
import urllib.error
import ipaddress
import uuid
import socket
import subprocess
import sys
import shutil

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import widgets as WIDGETS             # widgets have their own origin, store and policy
import response_layer as RESPONSE_LAYER
import response_authoring as RESPONSE_AUTHORING
import response_openui as OPENUI
import response_images as OPENUI_IMAGES
import response_lookup as PUBLIC_LOOKUP
import uvicorn

import redact as _redact

HERMES = os.environ.get("JARVIS_HERMES_HOME") or os.path.expanduser("~/.hermes")
# Every child this process starts — the one-shot turn and the warm ACP agent — inherits this. On a
# staging unit it points at the staging home; on live the variable is absent and nothing changes.
_AGENT_HOME = os.environ.get("JARVIS_LIVE_AGENT_HOME")
if _AGENT_HOME:
    os.environ["HERMES_HOME"] = _AGENT_HOME
HERE = os.path.dirname(os.path.abspath(__file__))
try:
    _redact.load_known_secrets(os.path.join(HERMES, "jarvis_live_token"))
except Exception:
    pass

PORT = int(os.environ.get("JARVIS_LIVE_PORT", "8150"))
VOICE = "79554ca723f442a3af718d5aee6751ab"
SPEED = 1.0                       # speech rate; the Settings panel owns it, the synthesis call reads it
FISH_MODEL = "s2.1-pro-free"
FRONT_MODEL = "deepseek-v4-flash"
SHIM = "http://127.0.0.1:8140"
COOKIE = "jl"
WORK_MARK = "[[WORK]]"

# A reply that only promises to do something. The fast layer is told to end such a line with the
# work marker; when it forgets the marker, the promise would otherwise be the whole turn and he is
# told "on it" while nothing is ever done. The server refuses to let a promise be an answer.
PROMISE = re.compile(
    r"^(on it|working on it|one moment|one second|right away|let me|checking|pulling|looking "
    r"into|i'?ll (check|look|pull|get|find|do)|give me a (moment|second))", re.I)

# A request shaped like work, rather than a question with an answer. The fast layer cannot do
# anything at all, so a request like this goes to the layer that can act before it is given the
# chance to describe work it has not done: it once answered a whole six-step screen sequence with
# "all six landed", and sent nothing. Handing over costs a slower answer; the reverse costs him a
# false claim, which is worse.
#
# The volatile half of this pattern is about SOURCES, not about work. The fast layer has none, so
# anything whose answer moves must reach the layer that can look it up. Measured failure: asked the
# dollar rate in Kampala, the fast layer answered in 1.1 seconds with "about 3,980 mid-market,
# bureaus selling near 3,640" — three numbers no source in this system has ever seen, spoken in his
# voice, on his page. tests/routing.json has always expected that row to be work; the vocabulary
# simply was not there, so the model's own gate let a guess through. A price he might act on is the
# one answer never to take from memory. Kept clear of the clock question ("today's date and time"),
# which the fast layer CAN answer because the time rides on his message.
WORKISH = re.compile(
    r"\b(show|shown|put up|display|draw|walk me|screen|panel|send|read me|read out|check|look up|"
    r"look at|find|fetch|search|list|table|numbers|figures|log|diary|ledger|continue|next|go on|"
    r"go ahead|carry on|do it|again|where is|where's|how many|recommend|recommendations|"
    r"options|compare|shortlist|suggest|which should|what should i|"
    r"rate|rates|exchange|dollar|dollars|usd|shilling|shillings|ugx|price|prices|cost|how much|"
    r"worth|latest|news|weather|forecast|score|scores|results|standing|standings|"
    r"right now|currently|at the moment|pricing|rundown|put together|tally)\b", re.I)

def text_needs_agent(question):
    """Keep the existing classifier; explicit sites/URLs cannot be read by the fast model."""
    return bool(WORKISH.search(question) or re.search(
        r"https?://|\b(?:my|our|private)\s+(?:private\s+)?(?:site|dashboard|portal)\b", question, re.I))


# Limits on what can be pushed into the transcriber: a runaway or malicious upload must not be
# able to occupy the machine, and only two transcriptions may run at once on four cores.
MAX_STT_BYTES = 2 * 1024 * 1024
MAX_STT_SECONDS = 25.0
STT_SEMAPHORE = threading.BoundedSemaphore(2)

SYSTEM = (
    "You are JARVIS, Mohammad's personal assistant. He is in Kampala, Uganda, and he is "
    "talking to you through your own private page on his phone. Everything you write is "
    "read aloud as you write it, so write for the ear: short sentences, plain words, no "
    "markdown, no bullets, no emoji, no headings, no file paths, no code. If a table is the "
    "honest shape for something, give it a blank line before and after and its own header rule "
    "row -- a table run into the sentence around it prints as pipes. Lead with the "
    "answer, then stop. Dry wit is welcome, padding is not. Default to two or three short "
    "sentences unless he asks for detail, because every extra sentence costs him time.\n\n"
    "You are one JARVIS, not several. You have tools, his files, the web and memory, and "
    "when a request needs them you simply go and use them yourself. Never mention layers, "
    "handoffs, other agents or models, and never say you cannot reach something. If you "
    "need to work, write only " + WORK_MARK + ", alone, with nothing before it and nothing "
    "after it, and say nothing else at all. The screen already shows that the work has started, "
    "so a line announcing it is filler and is not wanted. "
    "Never write tool calls, function syntax, tags, angle brackets or any machine "
    "markup. You have no visible tools and nothing you emit can invoke one: the "
    "marker above is the only control you may ever write. "
    "Everything you write is spoken aloud, so all of it must be prose a person can hear: "
    "no lists, no paths, no code, no status lines, no emoji. For greetings, opinions and "
    "anything you already know, just answer normally and never emit that marker.\n\n"
    "A short reply that only continues something, yes, go ahead, next, continue, do it, send it "
    "again, where is it, belongs to the work layer: whatever it continues was done there and not "
    "here. You cannot show anything, send anything, open anything, run anything or look anything "
    "up, and you must never say you have. Put " + WORK_MARK + " alone, with no words anywhere "
    "near it. A sentence promising work that you are not doing is filler, the one thing he has "
    "asked you never to write.\n\n"
    "A screen is real, and what it shows is not yours to guess at: there is one in front of "
    "him and the work layer puts things on it. Anything he asks to be shown, put up, "
    "displayed or drawn goes straight to the work layer, even when he does "
    "not say what he wants to see: " + WORK_MARK + " on its own, or as near that as an answer "
    "to the question is. "
    "Never tell him there is no screen, and never say a screen cannot be reached: you do not "
    "know that, and the layer that does is the one that will answer.\n\n"
    "Standing facts: he owns InspectFirst, a vehicle inspection business in Kampala, site "
    "battemohammad.com. He supports Arsenal. He prefers plain language and hates filler.\n\n"
    "Never state a date, a weekday, a time, an exchange rate, a market price, a distance or any "
    "other figure that changes with time: what you hold is stale or invented, and he acts on "
    "what you say. If he names one of those, or asks what anything is worth or costs right now, "
    "or asks about his own files, records or documents, then say one short line that you are on "
    "it and hand it over rather than answering. The one exception is the clock: the current date "
    "and time are attached to his message, so when he asks for the date or the time, answer it "
    "directly and naturally, as in 'it is half past nine in the morning', and never hand that "
    "over."
    "An explicitly labelled illustration or demo is not a claim about reality: when he asks for a demonstration, invented figures are allowed and wanted, provided every one of them carries the word illustrative or simulated and none carries a date or a source.\n\n"
    "How he wants to be spoken to, from his own profile. No em dashes, ever: use a comma or a "
    "full stop. No disclaimers, no hedging, no 'as an AI': give the conclusion and name only a "
    "real unknown. Never open with the word 'I', and never narrate what you are doing or how "
    "hard it was. Casual and direct, the way he talks. Call him sir sparingly, where it carries "
    "weight, never as a tic. Nahia is his girlfriend: call her Nahia, or a warm pet name, never "
    "a surname. He measures money against about two million shillings a month, so put any figure "
    "beside that. If one option is clearly better, give that one rather than a menu. When he is "
    "wrong, say so in one line with the reason, then move on. Never manufacture praise or "
    "enthusiasm, and never end with an offer to help further."
)

# What changes when he reads the answer instead of hearing it. Done by replacement rather than by
# keeping a second copy of a long prompt: two copies drift, and the failure would be a text reply
# still written for the ear (no lists, no structure) with no error anywhere. The raise means a
# later edit to the wording stops the turn loudly instead of silently dropping the swap.
# A spoken sentence in the persona is the only thing that may not reach a written turn, and the
# persona is his to edit, so it is taken out by pattern rather than by an exact match that an edit
# silently breaks. What each mode asks for is then stated once, below, and appended.
VOICE_ONLY = re.compile(r"Everything you write is (?:read|spoken) aloud[^.]*\.\s*")

TEXT_MODE_NOTE = (
    "This turn is read on a screen. This overrides spoken-only restrictions on lists and markup. "
    "Lead with the answer in plain words. A simple calculation needs its result and working, "
    "usually one or two sentences; numbers alone do not justify a table. Use bullets for short "
    "recommendations, steps for an ordered process, metrics for a few deciding figures, comparison "
    "panels for two or three entities with several attributes, and a gallery only when pictures "
    "help identify the subject. Use a chart when the shape of verified data matters. A table earns "
    "its place when the reader needs an exact matrix of shared attributes or explicitly asks for "
    "one. Choose by the information, not keywords such as compare, weather or savings. Do not add "
    "a table to an explanation, a calculation or a list merely to make it look structured. "
    "Reuse the existing supported components; prose and lists remain valid answers. Do not add "
    "controls unless the user asked to interact. Keep long answers in short sections, with no "
    "filler, repeated dataset or sign-off. Layout limits are not tool limits: use the available "
    "research tools for facts, and do not claim a venue directory or another tool is unavailable "
    "merely because there is no matching UI component. If retrieval actually fails, name that gap."
)

# The shared MECHANICS below also serves voice. Keep that contract unchanged, and give both
# written paths the same screen contract rather than conflicting bare-JSON/fenced-JSON advice.
TEXT_MECHANICS = (
    "Write each legacy display component as one complete fenced ui JSON object using the library "
    "below. Declared interactive components follow the separate exact schema; never mix the two "
    "contracts. Never write HTML or executable code to create a response component. A pipe table "
    "has a header and separator, with the same number of cells in every row. A rank needs its own "
    "header. Preserve full names, meaningful labels and units; do not abbreviate a label into "
    "ambiguity to fit a phone. Prefer a compact matrix; wide tables scroll. Put sentence-length "
    "explanations in prose or steps. Escape literal pipes inside cells as \\|. Write a dataset "
    "once, in its component or table, and explain only the useful conclusion beside it. Cite "
    "retrieved figures with their source and observation date. Calculations identify their user "
    "inputs and assumptions. Never invent observations, pad missing periods or imply an "
    "illustration was measured. A source label alone is not proof of retrieval. Code requested "
    "as the answer uses a language-tagged code fence; ordinary lists use '- ' lines."
)


def system_for(mode):
    """The fast layer's system prompt for this turn's mode: spoken or read.

    Voice is the persona exactly as written and edited. Text is the same persona minus any sentence
    that tells it the reply is heard, plus the screen instruction, so the distinction holds however
    the persona is reworded.
    """
    if mode != "text":
        return SYSTEM
    return VOICE_ONLY.sub("", SYSTEM).strip() + "\n\n" + TEXT_MODE_NOTE


# ------------------------------------------------------------------ the format router
# One decision, made before anything is written: the shape this answer should take. It is read off
# what he ASKED FOR, not off what he asked about, because the same subject can want a table, a
# snippet or a paragraph. Order is the priority: a request naming code and a list is a code request,
# and a request naming figures is a table before it is a list of options.
FORMAT_RULES = (
    ("code", re.compile(
        r"\b(code|coding|script|snippet|function|regex|command|shell|bash|powershell|sql|query|"
        r"python|javascript|typescript|node|html|css|json|yaml|patch|diff|refactor|unit test|"
        r"curl|endpoint|api call|class|method|algorithm)\b")),
    ("compare", re.compile(
        r"\b(compare|comparison|compared|versus|vs\.?\b|side by side|head to head|which is better|"
        r"better value|difference between)\b")),
    ("chart", re.compile(
        r"\b(trend|trends|over time|over the (last|past)|growth|growing|per (day|week|month|year)|"
        r"by month|monthly|weekly|history of|"
        r"how (has|did|is|are) .{0,30}(chang|mov|do|does|doing|done|perform|grow|trend)\w*\s+"
        r"(this|last|the past|over the|in the)\s+(month|week|quarter|year|day|season)|plot|graph|chart|forecast|"
        r"projection|year on year|compared with last)\b")),
    ("steps", re.compile(
        r"\b(the steps|step by step|what(?:'s| is) the process|in what order|walk me through|"
        r"walk me through it|checklist|procedure|workflow|from start to finish|sequence of)\b")),
    ("table", re.compile(
        r"\b(table|metrics?|telemetry|stats|statistics|"
        r"breakdown|specs?|specification|side by side|uptime|downtime|cpu|ram|memory|disk|"
        r"bandwidth|latency|throughput|benchmarks?|ports?|processes?|load average)\b")),
    ("cards", re.compile(
        r"\b(news|headlines?|stories|story|spots?|places?|restaurants?|options?|choices?|"
        r"alternatives?|recommend(?:ed|ations?)?|suggest(?:ed|ions?)?|ideas?|shortlist|list|round ?up|"
        r"nearby|nearest|things to do|where (can|should|to)|best .{0,20} in)\b")),
)

def route_format(question):
    """The one shape this answer should take, or prose when nothing structural was asked for."""
    text = str(question or "").lower()
    for shape, rx in FORMAT_RULES:
        if rx.search(text):
            return shape
    return "prose"


# What each shape means, told to the layer that writes the words. Written turns carry the structure
# in the answer itself, because the page draws it there. A spoken turn cannot: a table or a snippet
# read aloud is noise, so the shape goes to the screen and the voice keeps one line about it.
# The component library the page draws itself. One fence, one JSON spec, five components and the
# four text shapes beside them. Written turns carry it in the answer; the answer surface is where
# he reads, so this is what "the format depends on what you asked" means on this page.
UI_LIBRARY = (
    "{\"type\":\"metrics\",\"items\":[{\"label\":..,\"value\":..,\"unit\":..,\"delta\":..}]} (at most 6), "
    "{\"type\":\"chart\",\"kind\":\"bar\"|\"line\",\"title\":..,\"unit\":..,"
    "\"data\":[[\"label\",number], ..]} (at most 8 bars or 12 points), "
    "{\"type\":\"compare\",\"title\":..,\"columns\":[{\"name\":..,\"badge\":..,"
    "\"img\":\"a phrase to find a picture for\",\"points\":[\"one fact\", ..]}],"
    "\"verdict\":{\"winner\":..,\"line\":..}} (two or three columns, at most 5 points each), "
    "{\"type\":\"steps\",\"title\":..,\"steps\":[{\"label\":..,\"detail\":..}]} (at most 8), "
    "{\"type\":\"image\",\"img\":\"a phrase to find a picture for\",\"caption\":..,"
    "\"source\":\"where the picture came from\"} (one picture with its credit), "
    "{\"type\":\"gallery\",\"title\":..,\"images\":[{\"img\":\"a phrase\",\"caption\":..}]} (two to four), "
    "{\"type\":\"sources\",\"title\":..,\"items\":[{\"title\":..,\"url\":\"https://..\",\"note\":..}]} (at most 6), "
    "{\"type\":\"choices\",\"title\":..,\"options\":[{\"label\":..,\"value\":..}]} (at most 5)."
    )

# RETIRED (10 October 2026): the router no longer imposes one of these on an answer. Its per-shape
# text is kept only as a record of the mechanics the taxonomy in FAMILIES/MECHANICS now carries;
# nothing routes an answer to an entry any more, and nothing should re-wire it to.
FORMAT_TEXT = {
    "table": ("Give this answer as a pipe table: a header row, a --- rule under it, then one row "
              "per item, every row with the same number of cells. If the answer is three figures and "
              "nothing else, give them as a metrics component instead: a fenced block tagged ui "
              "holding {\"source\":\"where each figure was read from, and when\",\"type\":\"metrics\","
              "\"items\":[{\"label\":\"...\",\"value\":\"...\",\"unit\":\"...\"}]}."),
    "chart": ("Give this answer as ONE fenced block tagged ui, opening on its own line with nothing "
              "else on that line, holding nothing but a JSON spec of a chart: "
              '{"source":"where each figure was read from, and when","type":"chart","kind":"bar",'
              '"title":"...","unit":"...","data":[["label",12],["label",9]]}'
              ". Round the figures, put real labels on the bars, and write nothing about the block "
              "itself above or below it; the answer's other parts may follow it as their own blocks. "
              "Every figure must come from something you actually read this turn, with its date. "
              "If you have no source for the numbers, do not draw this block at all: say it in prose "
              "and say what you would need."),
    "compare": ("Give this answer as ONE fenced block tagged ui, opening on its own line, "
                "holding nothing but a JSON spec: "
                + '{"source":"where each figure was read from, and when","type":"compare","title":"...","columns":[{"name":"Bolt","badge":"17%","points":["one fact","another"]},{"name":"Faras","badge":"10%","points":["one fact","another"]}]}' +
                ". Two or three columns, the same kind of fact down each, at most five points each, "
                "and one short sentence at most above the block; the answer's other parts may follow "
                "it as their own blocks. Every figure must come from "
                "something you actually read this turn, with its date; with no source for the numbers, "
                "do not draw this block, say it in prose and say what you would need."),
    "steps": ("Give this answer as ONE fenced block tagged ui, opening on its own line, "
              "holding nothing but a JSON spec: "
              + '{"type":"steps","title":"...","steps":[{"label":"...","detail":"..."},{"label":"...","detail":"..."}]}' +
              ". One step per line of the process, in order, and nothing about the block itself above "
              "or below it; the answer's other parts may follow, and may come before it."),
    "cards": ("Give this answer as '- ' lines and nothing else: one line per item, each opening "
              "with a bold name and then the detail. Every option is its own line. Put a source at "
              "the end of the line it belongs to as a markdown link with a full address, written "
              "exactly as [Mutaano](https://mutaano.com), and write no sentence before the list or "
              "after it."),
    "code": ("Give this answer as one fenced triple-backtick block holding the code, with the "
             "language named on the fence, and nothing above or below it but, at most, one short "
             "sentence."),
    "prose": ("Give this answer as plain prose paragraphs, a bold header only where the answer "
              "really has parts, and a '- ' line only where a set of items reads faster than "
              "sentences."),
}
# RETIRED with FORMAT_TEXT: SPOKEN_NOTE carries what the talking turn needs, without naming a
# shape for the whole answer.
FORMAT_SPOKEN = {
    "chart": ("This is a change over time. Put it on his screen as a reply panel with a chart in it "
              "and keep the spoken part to one short line about it."),
    "compare": ("This is a comparison. Put it on his screen as a reply panel, the two things side by "
                "side, and keep the spoken part to one short line about it."),
    "steps": ("This is a process. Put it on his screen as a reply panel, one step per line in order, "
              "and keep the spoken part to one short line about it."),
    "table": ("This is a set of figures. Put it on his screen as a table and keep the spoken part "
              "to one short line about it."),
    "cards": ("This is a set of options. Put it on his screen as a reply panel and keep the spoken "
              "part to one short line about it."),
    "code": ("This is code. Put it on his screen and keep the spoken part to one short line about it."),
    "prose": "",
}

# The one rule that applies to every shape in every medium.
UI_NOTE = (
    "The page draws a small library of its own, and a written answer may use it wherever the words "
    "cannot do the job: " + UI_LIBRARY + " A component is written as its bare spec on its own line, "
    "opening with { and ending with }, with no code fence around it and at most one short sentence "
    "beside it on a line of its own. Use one where it carries the "
    "answer and do not reach for one where a sentence or a list already does.")

FAMILIES = (
    "Build the answer out of whatever carries it, and know what each thing is FOR:\n"
    "prose, for reasoning, transitions, context, and anything the reader follows in sentences;\n"
    "cards, for distinct entities or option packages that each hold several attributes;\n"
    "a chart, for a trend, a distribution, or a set of figures whose shape is the point;\n"
    "a table, for a side-by-side matrix, or attributes dense enough that columns beat sentences;\n"
    "a callout, for the one figure, warning or status flag that decides the answer.\n"
    "One answer may use several of these in the order its content has, and return to prose between "
    "them. That is the whole licence, and it has two edges: never draw one to decorate a sentence, "
    "and never write a sentence that only points at one.")

RESTRAINT = (
    "Restraint matters more than the library does. A run of tips, a set of simple points or short "
    "advice is a list he reads down, so it is '- ' lines and never separate cards; cards and "
    "side-by-side panels are for distinct objects that each carry their own attributes. Never draw an "
    "interactive thing, a picker, a set of options to choose from or a button, unless he has actually "
    "asked to choose or pick something, and never hand him a follow-up menu he did not ask for. If a "
    "sentence or a plain bullet list carries it without losing context, that is what it should be: a "
    "component has to earn its place, and plain text is the default.")

MECHANICS = (
    "How each is written. A pipe table: a header row, a --- rule under it, then one row per item, "
    "every row with the same number of cells, and every cell short: a header or a cell is under "
    "about ten characters wherever the data allows it, because a long cell squashes the columns on "
    "a phone. Dates are written short (Q3 2025, Oct '25), figures are rounded and abbreviated "
    "(1.2M, 45k), units go in the header once rather than in every row, and a cell that needs a "
    "sentence does not belong in a table: say it in the prose beside it. Where a name runs past "
    "that, give its shortest form that still reads (Airport pickup becomes Airport, Weekly or "
    "standing becomes Weekly) rather than letting the column fill with words. A dataset is drawn "
    "once: if a component carries it - a table, a chart, a set of tiles - the raw markdown of that "
    "same dataset does not appear anywhere else in the answer, and a chart names its source inside "
    "its own payload rather than on a line above or below it. An answer runs context first, then the "
    "component, then the reading of it. Nothing leaks below a component as a stray line of raw "
    "markdown: a row is written with its pipes on both ends, and a footnote, a citation or a "
    "supplementary figure goes inside the component - its source field or its own row - or into the "
    "prose beside it, never as a half-written row printed under the table. Anything carrying figures carries \"source\": where "
    "each figure was read from and when, named there and never null and never left out, and with no "
    "source the component is not drawn at all: the figures go in prose and the gap is said plainly. "
    "A dataset a component carries goes wholly inside that component's own array, and no row of it "
    "is left outside as markdown pipes. "
    "A chart, a comparison, a set of steps, a set of figures "
    "or a set of options is written as its bare spec, on its own line, opening with { and ending "
    "with }, holding nothing but that spec and with NO code fence around it: the page reads the spec "
    "itself and a fence is what puts raw JSON on his screen when something goes wrong. A command or a snippet goes in a fenced "
    "triple-backtick block with the language named on the fence. A list of items or options may "
    "instead go on '- ' lines, one per item, each opening with a bold name and then the detail. "
    "Anything that is a shape rather than a sentence belongs on his screen.")

SPOKEN_NOTE = (
    "You are answering out loud, and every word is also written on his screen, so the answer has to "
    "work as both. Give the result first, and keep it as short as the answer allows, usually one to "
    "three sentences, longer only when he asked for detail: no file paths, no code, no tool output, "
    "no status lines.")

COMPOSE = (
    "Choose it as you write, part by part, and let the content set the order: an answer may open in "
    "prose, carry its figures in a component, set a choice out as a table and close on the line that "
    "decides it. The structure is mandatory and the decoration is forbidden.")

NO_FILLER = (
    "Write no conversational scaffolding at all. Never open with 'here is', 'here is what you "
    "asked for', 'as you can see' or anything like them; never announce what you are about to "
    "write; never count items out loud as one, two, three; never close by saying the table, the "
    "cards or the code are on his screen or in front of him, because he is looking at them; never "
    "offer to tidy, expand, shorten or redo it, and never ask whether he wants more. The structure "
    "is the message: put nothing above it and nothing below it that it already says. "
    "He reads on a phone, so a long answer is scanned and not read: open on the substance itself, "
    "in the first line, never on a sentence about the answer, and never run two subjects together "
    "in one block of text. On the screen, a long or multi-topic answer goes in short blocks under a "
    "bold heading that names each subject, one subject to a block, with figures, lists and items on "
    "'- ' lines instead of buried inside a paragraph, and never more than two sentences to a block. "
    "Speaking, keep the same order and the same short blocks, without the headings. ")
NO_VOICE_LOSS = (
    "The shape is layout, not voice: stay yourself inside it. The conclusion in the first line, "
    "plain words, no hedging and no disclaimers, no cheerleading and no sign-off, and the one dry "
    "line only where it actually lands. A heading names a part of the answer, it never announces "
    "one, and a short answer stays short: this shapes length, it never adds any.")

# The reasoning levels the page offers, and the only ones this side will pass to the CLI as an
# argument. `none` is what the page ran before the control existed, so it stays the default and a
# missing field keeps behaving exactly as it did.
# The whole ladder the agent accepts, in order. The page offers all of it; what each rung costs is
# the provider's business, and on DeepSeek V4 (low, medium, high, max, with xhigh overridden to max)
# the last three all land on max. Kept in the agent's own spelling, because these strings are passed
# straight to `--reasoning`.
# The page's default level, and what it resolves to on the way to the CLI. `auto` is the page's own
# routing kept intact — a simple question is answered at once, work goes to the agent — with the
# agent working at this effort when it is asked to. It is not a level the CLI knows, so it is named
# separately from the ladder and resolved before the argument is built.
AUTO_REASONING = "auto"
AUTO_EFFORT = "low"
REASONING_LEVELS = ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra")

# Armed from Quick Tools on the page. A turn that carries it is a turn he asked to be searched for,
# so the search happens before the answer rather than as something the answer mentions doing.
WEB_NOTE = (
    "He asked for this one to be a web search. Search the web before you answer, and cite each "
    "source you actually used with its link; if the search returns nothing usable, say so plainly "
    "rather than answering from memory as though it had been checked. ")

# Switched off from Quick Tools for one turn. The fast layer preloads MEMORY.md and USER.md into its
# own prompt, so a turn with this on it never goes there — the setting is honoured by the layer that
# can read the instruction, not pretended at by a layer that cannot.
NO_MEMORY_NOTE = (
    "For this turn he has turned his stored memory off. Answer without drawing on anything you have "
    "kept about him from other conversations: no memory file, no long-term facts, no recall of past "
    "sessions. The conversation in front of you is still in scope. If the answer genuinely needs "
    "something only that stored memory holds, say so rather than guessing. ")


def format_directive(shape, mode):
    """What the answer may be made of, and the licence to choose it while writing.

    `shape` is the router's reading of the question. It is still sent to the page as a RENDER hint
    (how a '- ' list should be drawn) and is deliberately NOT used to name the answer's layout: no
    shape is imposed, and the component is chosen from the payload as the answer is written.
    """
    if mode == "text":
        return TEXT_MODE_NOTE + " " + FAMILIES + " " + RESTRAINT + " " + TEXT_MECHANICS + " Supported display library: " + UI_LIBRARY + RESPONSE_LAYER.prompt_note()
    return FAMILIES + " " + RESTRAINT + " " + MECHANICS + " " + SPOKEN_NOTE + " " + COMPOSE

KAMPALA = zoneinfo.ZoneInfo("Africa/Kampala")


def now_line():
    """The clock, for the fast layer only.

    Attached to his message rather than added to the system prompt: the system prompt is the long
    shared prefix, and keeping it byte-identical from turn to turn is what lets the provider's
    prefix cache work. It is never stored in history.
    """
    t = datetime.datetime.now(KAMPALA)
    return ("[Clock: %s, %s EAT. Use this only if he asks for the date or the time.]"
            % (t.strftime("%A %-d %B %Y"), t.strftime("%-I:%M %p")))


IDENTITY_CACHE = {"at": 0, "text": ""}


def identity():
    """The same soul and the same memory the engine runs on, so the quick answers are
    mine rather than a generic assistant's. Cached for a minute and kept compact: this
    text is prefilled on every turn, so length costs latency."""
    now = time.time()
    if now - IDENTITY_CACHE["at"] < 60 and IDENTITY_CACHE["text"]:
        return IDENTITY_CACHE["text"]
    parts = []
    for name, cap in (("SOUL.md", 2200), ("MEMORY.md", 1400), ("USER.md", 1400)):
        for sub in ("", "memories/"):
            path = os.path.join(HERMES, sub + name)
            if os.path.exists(path):
                try:
                    parts.append("## " + name + "\n" + open(path, encoding="utf-8").read()[:cap])
                except Exception:
                    pass
                break
    text = "\n\n".join(parts)
    IDENTITY_CACHE.update({"at": now, "text": text})
    return text


def env(name):
    p = os.path.join(HERMES, ".env")
    if os.path.exists(p):
        for line in open(p, encoding="utf-8", errors="ignore"):
            m = re.match(r"^\s*(?:export\s+)?%s\s*=\s*(.+?)\s*$" % re.escape(name), line)
            if m:
                return m.group(1).strip().strip('"').strip("'")
    return os.environ.get(name)


TOKEN = open(os.path.join(HERMES, "jarvis_live_token")).read().strip()
SHIM_KEY = open(os.path.join(HERMES, "shim_auth_key")).read().strip()
DS_KEY = env("DEEPSEEK_API_KEY")
FISH_KEY = env("FISH_AUDIO_API_KEY") or env("FISH_API_KEY")

app = FastAPI()
app.mount("/static", StaticFiles(directory=os.path.join(HERE, "static")), name="static")
if os.path.isdir(os.path.join(HERE, "vendor")):
    app.mount("/vendor", StaticFiles(directory=os.path.join(HERE, "vendor")), name="vendor")


@app.on_event("startup")
async def _page_startup_recovery():
    __import__('threading').Thread(target=_page_recover_once,daemon=True).start()
from page.legacy import TextLane as _PageTextLane
PAGE_TEXT = _PageTextLane(globals())
_PAGE_RECOVERED = False
_PAGE_RECOVERY_LOCK = __import__('threading').Lock()


def _page_recover_once():
    """Startup ownership: run once per process, under a lock, retried until it succeeds.
    Uncertain tool work is failed visibly by recover_interrupted; it is never rerun."""
    global _PAGE_RECOVERED
    if _PAGE_RECOVERED:return
    with _PAGE_RECOVERY_LOCK:
        if _PAGE_RECOVERED:return
        try:
            PAGE_TEXT.adapter.recover_interrupted()
            _PAGE_RECOVERED=True
        except Exception as exc:
            print("page recovery retry pending:", type(exc).__name__, exc, flush=True)


# The console is a pair of files I keep refining. Browsers happily serve the old copy from
# cache, which is invisible and confusing ("my change did not work"), so never cache them.
# no-store, not no-cache: this host sits behind Cloudflare, whose browser cache setting rewrites
# a plain no-cache into a four hour max-age, and the copy a phone then holds is the one that was
# there when he first loaded the page. The validators go too, so nothing can answer a conditional
# request with "not modified" while holding something old.
@app.middleware("http")
async def _no_cache_console(request, call_next):
    resp = await call_next(request)
    # The three headers that cannot break a page, set here so every response carries them.
    # Deliberately not a Content-Security-Policy: the page is built on inline scripts, so a CSP
    # written quickly is a CSP that breaks the app. That one gets its own careful pass.
    resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    if request.url.path in ("/static/hud.css", "/static/hud.js", "/static/hardlight.js",
                            "/static/workview.css", "/static/workview.js",
                            "/static/v1.css", "/static/v1.js", "/static/approvals-ui.js"):
        resp.headers["Cache-Control"] = "no-store, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        for h in ("ETag", "Last-Modified"):
            if h in resp.headers:
                del resp.headers[h]
    return resp


HISTORY = []
HISTORY_LOCK = threading.RLock()  # reentrant: a helper that takes this lock must be callable while it is held
HISTORY_MAX = 12          # last six exchanges, enough for follow-ups, short enough to prefill fast
# A conversation that has gone cold is a fresh one. The window was restored at boot and never
# aged, so an exchange from an hour ago still coloured what he asked now. Chosen deliberately:
# half an hour keeps a normal back-and-forth together and drops yesterday's thread.
IDLE_RESET_SECONDS = 30 * 60
HISTORY_FILE = os.path.join(HERE, "session.json")
TURN = {"n": 0, "by": {}}           # newest turn id, and the newest turn in each conversation
# A turn is valid while it is the newest turn IN ITS OWN CONVERSATION. It used to be valid only while it
# was the newest turn anywhere, so starting a second chat invalidated the turn still running in the first
# one: its answer could no longer be committed and the chat he left looked broken when he came back.
LIVE_TURNS = {}                     # turn id -> {"yes": abandoned flag, "conv": its conversation id}
LIVE_LOCK = threading.RLock()  # reentrant: a helper that takes this lock must be callable while it is held

# --------------------------------------------------------------------- a turn's own buffer
# The turn used to be the HTTP response: the page closing that response ended the work and the words
# went with it. That is the wrong owner. A turn is work he asked for, it belongs to the conversation
# he asked it in, and a page is one reader of it — so the turn keeps its own log, its own readers and
# its own life, and a reader that leaves is a reader that left. A page that comes back attaches to the
# same turn, is handed everything it missed in order, and then carries on live.
TURN_LOG_MAX = 6000                 # events kept for a reader who arrives late
TURN_KEEP_AFTER = 300.0             # seconds a finished turn stays attachable
TURN_CHANS = {}                     # turn id -> TurnChan
TURN_CHANS_LOCK = threading.RLock()  # reentrant: a helper that takes this lock must be callable while it is held


class TurnChan:
    """One turn's events, and the readers currently attached to them."""

    def __init__(self, turn, question, mode, conv, tid=""):
        self.turn = turn
        self.question = question
        self.mode = mode
        self.conv = conv              # the conversation it was asked in: a turn knows its own home
        # THE name of this turn, for everyone: the page's own id when it sent one, otherwise the one
        # minted here. Published on every open, written into the execution log and echoed back, so a
        # page, a record and a query all mean the same turn by the same name.
        self.tid = str(tid or "")
        self.events = []            # (seq, name, data), oldest first; sound is never kept
        self.subs = []              # [(loop, queue)] readers attached right now
        self.n = 0                  # every event is numbered, sound included: a reader says since N
        self.started = time.time()  # for the drawer row of a conversation whose first answer is unwritten
        # The steps this turn runs, in order, kept on the turn itself: the conversation's record gets them
        # whether or not the page that watched the turn got a chance to write its own copy.
        self.steps = []
        self.status = "running"
        self.done = False
        self.ended = None
        self.lock = threading.RLock()
        self.redactor = _redact.Stream()
        self.token_kind = "front"

    def publish(self, name, data, flushed=False):
        """Called from the turn's worker thread: to every reader, then into the log."""
        with self.lock:
            if self.done:
                return
            payload = dict(data) if isinstance(data, dict) else {"d": data}
            if name == "tok" and not flushed:
                self.token_kind = payload.get("kind") or self.token_kind
                payload["d"] = self.redactor.feed(str(payload.get("d") or ""))
                if not payload["d"]:
                    return
            elif name in ("text", "done"):
                tail = self.redactor.feed("", final=True)
                if tail:
                    self.publish("tok", {"d": tail, "kind": self.token_kind}, flushed=True)
            payload = _redact.redact_rows([payload], ("d", "text", "line", "title", "message", "err", "q"))[0]
            seq = self.n
            self.n += 1
            payload["seq"] = seq
            # Every chunk names its turn as well as its conversation. A reader can then refuse a chunk
            # that belongs to a different turn of the same chat, which is the one crossover the
            # conversation check alone cannot catch.
            if getattr(self, "tid", ""):
                payload["tid"] = str(self.tid)
            if self.conv:
                # Every chunk names the conversation it belongs to. One reader serves one turn, so this is
                # belt and braces on the wire — but a page that can see the name on each chunk can refuse
                # one from a conversation it is not showing, and one chat's words appearing under another
                # chat's heading stops being possible rather than merely unlikely.
                payload["conv"] = self.conv
            if name != "audio":
                # Sound made for a moment that has passed cannot be played late, and keeping it would
                # hold megabytes for a reader who cannot use it. The words travel with it — every
                # spoken unit has its matching token — so a re-attached page shows what was said
                # rather than silence.
                self.events.append((seq, name, payload))
                del self.events[:-TURN_LOG_MAX]
            subs = list(self.subs)
        for loop, queue in subs:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, (name, payload))
            except Exception:
                pass

    def attach(self, loop, since=0):
        """A reader joins: the backlog it has not seen, then everything from here on."""
        with self.lock:
            backlog = [(name, data) for (seq, name, data) in self.events if seq >= since]
            queue = asyncio.Queue(maxsize=8192)
            self.subs.append((loop, queue))
            done = self.done
        return backlog, queue, done

    def detach(self, queue):
        with self.lock:
            self.subs = [(l, q) for (l, q) in self.subs if q is not queue]

    def finish(self, status=None):
        """The turn is over. The log stays until the sweep: a page may be on its way back for it.

        The record goes to disk here, before any reader is told the turn ended, so what the screen
        shows afterwards is what the machine kept — not what a page happened to be holding when the
        answer arrived.
        """
        with self.lock:
            if self.done:
                return
            self.done = True
            self.ended = time.time()
            if status:
                self.status = status
            elif self.status == "running":
                self.status = "completed"
            subs = list(self.subs)
        _exec_record(self)
        for loop, queue in subs:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, ("__end__", {}))
            except Exception:
                pass


EXEC_FILE = os.path.join(HERE, "executions.jsonl")
EXEC_MAX = 1200                      # records kept on disk; the oldest fall off the front
EXEC_LOCK = threading.Lock()


def _exec_record(chan):
    """Keep what the turn did, on disk, whether or not anyone was watching.

    Steps only: the titles the turn's own work produced, the times it started and ended, and how it
    ended. No tool arguments, no tool output, no answer text — the conversation already holds the
    answer, and the arguments are where secrets live.
    """
    try:
        rec = {"conv": str(getattr(chan, "conv", "") or ""),
               "turn": str(getattr(chan, "turn", "") or ""),
               "tid": str(getattr(chan, "tid", "") or ""),
               "q": _redact.redact(str(getattr(chan, "question", "") or ""))[:200],
               "started": round(float(getattr(chan, "started", 0) or 0), 3),
               "ended": round(float(getattr(chan, "ended", 0) or 0), 3),
               "status": str(getattr(chan, "status", "completed") or "completed"),
               "steps": [_redact.redact(str(x))[:140] for x in (getattr(chan, "steps", None) or [])][:60]}
        line = json.dumps(rec, ensure_ascii=False)
        with EXEC_LOCK:
            with open(EXEC_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
            try:
                with open(EXEC_FILE, encoding="utf-8") as f:
                    rows = f.readlines()
                if len(rows) > EXEC_MAX:
                    with open(EXEC_FILE + ".tmp", "w", encoding="utf-8") as f:
                        f.writelines(rows[-EXEC_MAX:])
                    os.replace(EXEC_FILE + ".tmp", EXEC_FILE)
            except Exception:
                pass
        return rec
    except Exception as exc:
        print("exec record not written: %r" % (exc,))
        return None


def _exec_rows(conv, tid=None, limit=40):
    """What is on disk for a conversation, newest last."""
    out = []
    try:
        with EXEC_LOCK:
            if not os.path.exists(EXEC_FILE):
                return []
            with open(EXEC_FILE, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except Exception:
                        continue
                    if conv and str(rec.get("conv") or "") != str(conv):
                        continue
                    if tid and str(rec.get("turn") or "") != str(tid) and str(rec.get("tid") or "") != str(tid):
                        continue
                    out.append(rec)
    except Exception:
        return []
    return out[-limit:]


def _sweep_turns():
    """Finished turns are kept only long enough for a page to come back for them."""
    now = time.time()
    with TURN_CHANS_LOCK:
        for t in [t for t, c in TURN_CHANS.items()
                  if c.done and (now - (c.ended or now)) > TURN_KEEP_AFTER]:
            TURN_CHANS.pop(t, None)


def _live_started_for(conv):
    """When the still-working turn in that conversation began, as a unix time, or 0."""
    _page = PAGE_TEXT.live(str(conv))
    if _page:
        return _page['created_at']
    turn = _live_turn_for(conv)
    if turn is None:
        return 0
    with TURN_CHANS_LOCK:
        chan = TURN_CHANS.get(turn)
        return int(getattr(chan, "started", 0) or 0)


def _live_question_for(conv):
    """The question a still-working turn in that conversation was asked with, if there is one.

    The page can be told which conversation is being written in but not what it was asked — after a
    reload it has no memory of the ask at all — and without the question the canvas it rebuilds is a
    working light and a step list with nothing on it saying what the work is for.
    """
    _page = PAGE_TEXT.live(str(conv))
    if _page:
        return _page['request']['question']
    turn = _live_turn_for(conv)
    if turn is None:
        return ""
    with TURN_CHANS_LOCK:
        chan = TURN_CHANS.get(turn)
        return str(getattr(chan, "question", "") or "")


def _live_tid_for(conv):
    """The name of the turn still working in that conversation, if any.

    The page paints a running turn before any of its events arrive, so it has no id to hang the block
    on and a reloaded page cannot match that block to the turn the machine is writing. This is the
    same turn `_live_turn_for` reports, named the way both sides name it.
    """
    _page = PAGE_TEXT.live(str(conv))
    if _page:
        return _page['turn']
    conv = str(conv or "current")
    with TURN_CHANS_LOCK:
        for t in sorted(TURN_CHANS, reverse=True):
            c = TURN_CHANS[t]
            if str(getattr(c, "conv", "") or "") == conv and not getattr(c, "done", True):
                return str(getattr(c, "tid", "") or "")
    return ""


def _live_turn_for(conv):
    """The turn still working in that conversation, if any.

    One agent runs at a time here, but the page can be looking at a different conversation from the
    one being answered, and after a reload it knows nothing about what is running. This is what it
    reads to tell a record from something still being written. A turn that finished seconds ago still
    counts: a page reloading exactly at the end should re-bind and be given the whole turn rather than
    a record that has not caught up yet.
    """
    _page = PAGE_TEXT.live(str(conv))
    if _page:
        return 'page.'+str(conv)+'.'+_page['turn']
    conv = str(conv or "current")
    with LIVE_LOCK:
        for t in sorted(LIVE_TURNS, reverse=True):
            if str(LIVE_TURNS[t].get("conv") or "") == conv:
                return t
    now = time.time()
    with TURN_CHANS_LOCK:
        recent = [(t, c) for t, c in TURN_CHANS.items()
                  if c.conv == conv and c.done and (now - (c.ended or 0)) < 8.0]
    if recent:
        return max(t for t, _c in recent)
    return None


# The work layer runs ONE long-lived agent session. Left alone it carries the previous conversation
# into an unrelated question and can resume old work with real side effects: a live turn asking for a
# petrol price picked up an earlier task from that session and restarted this service. So the agent's
# session is scoped to the same window the page's own memory already uses, and rotates whenever that
# window resets, by idle timeout or by the reset button.
EPOCH = [0]
SESSION = {"id": ""}            # this conversation's own uuid, minted whenever one starts clean


def close_session():
    """The window is over: keep it, then start a clean one. Call while holding HISTORY_LOCK.

    The archive has to happen while the history is still here. It was cleared first at both call
    sites, so every conversation that ended by idle timeout or by the reset button was archived as an
    empty one — the drawer listed nothing, which is exactly what it looked like.
    """
    archive_session()
    HISTORY.clear()
    return new_session()


def new_session():
    """Mint a clean conversation id. Call while holding HISTORY_LOCK.

    Minted when a conversation starts over (the reset button, or the idle window closing) and at
    no other time. The id names the agent's session, so a new one is how the page stops replaying
    the previous conversation's turns into an unrelated question.
    """
    archive_session(SESSION["id"])
    # The turns that were just filed away belong to the conversation that has now closed, not to the new
    # one. Left in the window, the drawer showed them a second time as a live row under the new name: one
    # conversation, two headings. The new conversation starts with nothing in it.
    try:
        HISTORY.clear()
    except Exception:
        pass
    # A turn still working was asked in the conversation that has just closed. Retiring its id here is what
    # tells it so: the commit then refuses the live history and the answer is written into the record of the
    # conversation it belongs to. Without this the answer landed in the new window's history as well, and
    # one chat appeared twice under two names. (The lock is already held; new_turn() would deadlock.)
    TURN["n"] += 1
    EPOCH[0] += 1
    SESSION["id"] = uuid.uuid4().hex
    # Text sessions prewarm by explicit page conversation through PAGE_TEXT.
    # Creating a window must not start an unused legacy agent.
    return SESSION["id"]


def agent_session_name(conv=None):
    """The agent session for a conversation.

    Named after the conversation, not after the window: the window rotates whenever he opens a new chat,
    and a name taken from it meant a question asked in one chat ran in another chat's memory — or, worse,
    in a blank one that had forgotten the thread.

    Page-owned, not the old shared "jarvis-voice" thread: that one had grown to 402 messages, so a
    trivial question replayed 202,284 input tokens of history before answering, and it carried old
    work into unrelated questions. It rotates on the same 30-minute idle rule the page's own memory
    uses, so a cold window is a fresh agent.
    """
    cid = str(conv or "").strip()
    if re.fullmatch(r"[0-9a-fA-F]{8,40}", cid or ""):
        return "jarvis-live-" + cid[:12]
    if SESSION["id"]:
        return "jarvis-live-" + SESSION["id"][:12]
    return "jarvis-live" if EPOCH[0] == 0 else "jarvis-live-%d" % EPOCH[0]



def write_turn_ctx(conv, modes_path, guard_mode, guard_log, secret, approval_url, default_mode="ask"):
    """Write the turn the gate is serving, where a held-open child can read it.

    An agent kept alive across turns cannot be handed new environment, so the turn is named in a
    file keyed by the agent session — the same key the warm child is built with. Returns the path,
    or "" when it could not be written (the caller then falls back to the environment alone).
    """
    try:
        ctxdir = os.path.join(HERE, "ctx")
        os.makedirs(ctxdir, exist_ok=True)
        name = re.sub(r"[^0-9a-zA-Z_-]", "", agent_session_name(conv)) or "default"
        path = os.path.join(ctxdir, name + ".json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"JARVIS_WEB_TURN": "1",
                       "JARVIS_WEB_CHAT": str(conv or ""),
                       "JARVIS_WEB_MODES": modes_path,
                       "JARVIS_WEB_GUARD": guard_mode,
                       "JARVIS_GUARD_LOG": guard_log,
                       "JARVIS_APPROVAL_SECRET": secret,
                       "JARVIS_APPROVAL_URL": approval_url,
                       "JARVIS_WEB_DEFAULT_MODE": default_mode}, f)
        os.replace(tmp, path)
        return path
    except Exception as exc:
        print("turn context file not written: %r" % (exc,))
        return ""


def config_model():
    """The model the page's work layer runs, read from config so it follows his routing.

    Passed to the agent explicitly, because a resumed session restores the model it was CREATED
    with: measured, this page's session had been pinned to deepseek-v4-pro since 3 September and
    every work turn ran on it, at four times the price, against a config that says flash. An
    explicit -m is user intent and wins over the stored value. Read per turn, so a routing change
    lands without a restart here.
    """
    try:
        import yaml
        with open(os.path.join(HERMES, "config.yaml"), encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
        return str((cfg.get("model") or {}).get("default") or "").strip()
    except Exception:
        return ""

# Screens: every open artifact channel, one per browser tab that is sitting on the page. The turn
# stream is one request per turn, so between turns there was nowhere to put anything. This is the
# standing channel, and it exists for one reason: so the agent can show a thing rather than
# describe it.
SCREENS = {}                        # screen id -> (event loop, queue)
SCREENS_LOCK = threading.RLock()  # reentrant: a helper that takes this lock must be callable while it is held
SCREEN_SEQ = [0]
ART_SEQ = [0]                       # every panel carries its own number, so a repeat can be told
                                    # apart from a replay and shown again after a clear (B2)
# What is up on the screens right now. A panel pushed while the tab was asleep is the same failure
# as one never sent, and he cannot tell the two apart, so the page asks for this when it opens or
# reconnects.
LAST_ART = {"payload": None}

# What the screens have actually been given, as (when, kind, label). The turn that is speaking reads
# this so its progress lines can say what is on the screen instead of guessing, and so it stops
# talking once the screen has the answer. A panel pushed while the tab was asleep is not counted:
# this records what the screens took, not what the agent asked for.
ART_LOG = []
ART_LOG_MAX = 40

# Widgets live on their own origin (see widgets.py). The store is made on first use, and any
# widget past its expiry is dropped at startup rather than served from a tombstone.
WIDGETS.settings()
_culled = WIDGETS.purge_expired()
if _culled:
    print("widgets: dropped %d expired" % _culled)


def broadcast_art(payload):
    """Hand one typed artifact to every open screen. Returns how many took it.

    The queue belongs to another event loop, so the hand-off goes through that loop rather than
    being put from this thread. A screen that has gone away is skipped, not waited on.
    """
    # A clear is delivered live but never remembered: "what is up there" after a clear is nothing,
    # so a tab that wakes later is told the truth rather than handed the panel that was taken down.
    LAST_ART["payload"] = None if payload.get("kind") == "clear" else payload
    with SCREENS_LOCK:
        targets = list(SCREENS.items())
    sent = 0
    for sid, (loop, q) in targets:
        try:
            loop.call_soon_threadsafe(_screen_put, q, payload, sid)
            sent += 1
        except Exception:
            pass
    if sent:
        label = str(payload.get("label") or payload.get("title") or "").strip()
        ART_LOG.append((time.time(), str(payload.get("kind") or ""), label[:60]))
        del ART_LOG[:-ART_LOG_MAX]
    return sent


def panels_since(mark):
    """What the screens hold, as "<kind>: <label>", from the log position `mark`.

    A clear wipes the slate: after one, nothing is on the screen, and a progress line that says
    otherwise is the same untruth in the other direction.
    """
    out = []
    for _, kind, label in ART_LOG[mark:]:
        if kind == "clear":
            out = []
        elif kind:
            out.append((kind + ": " + label) if label else kind)
    return out


def _screen_put(q, payload, sid):
    """Put on that screen's queue, and drop the screen if it is not taking anything.

    The queue is small on purpose: a tab that has gone away without saying so fills it, and that
    is the signal to forget it. Without this, a killed browser leaves a screen on the books and the
    agent is told its artifact was shown when nobody saw it.
    """
    try:
        q.put_nowait(payload)
    except Exception:
        with SCREENS_LOCK:
            if SCREENS.get(sid) and SCREENS[sid][1] is q:
                SCREENS.pop(sid, None)

def new_turn(conv=None):
    with HISTORY_LOCK:
        TURN["n"] += 1
        n = TURN["n"]
        if conv:
            TURN["by"][str(conv)] = n
        return n


def own_turn(conv, n):
    """Claim the newest-turn slot of one conversation for turn n."""
    with HISTORY_LOCK:
        TURN["by"][str(conv)] = n


def invalidate_conv(conv):
    """Nothing in flight in this conversation may commit from now on. Its neighbours are untouched."""
    with HISTORY_LOCK:
        if conv:
            TURN["by"][str(conv)] = 0


def _sanitise(msgs):
    """Keep only well-formed alternating pairs. A user message with no answer, or two of
    the same role in a row, is what made the model answer a stale question."""
    out = []
    for m in msgs:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
            continue
        if out and out[-1]["role"] == m["role"]:
            out[-1] = m                      # same role twice: the later one wins
            continue
        out.append(m)
    while out and out[-1]["role"] == "user":
        out.pop()                            # never end on an unanswered question
    return out


def _load_history():
    try:
        if os.path.exists(HISTORY_FILE):
            data = json.load(open(HISTORY_FILE, encoding="utf-8"))
            if isinstance(data, list):
                HISTORY.extend(_sanitise(data)[-HISTORY_MAX:])
    except Exception:
        pass
    maybe_reset_idle()               # an old file is not restored past the idle threshold
    return len(HISTORY)


def commit(turn, user_text, assistant_text, conv=None):
    """Write one complete exchange. Nothing is written until the turn finishes, and a turn
    that was interrupted writes nothing at all — neither half. Half a turn in memory is
    worse than no turn: it leaves a question with no answer, and the next reply answers it."""
    with HISTORY_LOCK:
        # Judged against its own conversation. A turn in a chat he is no longer looking at is still that
        # chat's turn until a newer one is asked there, or that chat is stopped or reset.
        lane = TURN["by"].get(str(conv)) if conv else None
        if lane is not None:
            if turn != lane:
                return False
        elif turn != TURN["n"]:
            return False
        stamp = time.time()
        if user_text:
            HISTORY.append({"role": "user", "content": _redact.redact(user_text), "at": stamp})
        if assistant_text:
            HISTORY.append({"role": "assistant", "content": _redact.redact(assistant_text), "at": stamp})
        del HISTORY[:-HISTORY_MAX]
        # Atomic: a crash or a kill mid-write used to be able to leave a truncated history,
        # which is then replayed as JARVIS's own words on the next turn.
        try:
            tmp = HISTORY_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(HISTORY, f)
            os.replace(tmp, HISTORY_FILE)
        except Exception:
            pass
        return True


def recall(conv=None):
    with HISTORY_LOCK:
        if not conv or str(conv) == str(_session_key()):
            return list(HISTORY)
    with SESSIONS_LOCK:
        turns = list((SESSIONS.get(str(conv)) or {}).get("turns") or [])
    return [{"role": role, "content": t.get(field), "at": t.get("t", 0)}
            for t in turns[-HISTORY_MAX // 2:] for role, field in (("user", "q"), ("assistant", "a"))
            if t.get(field)]


def for_model(hist):
    """The outgoing messages, with only role and content.

    The stored entries carry a timestamp for the idle check. A provider that rejects unknown
    message keys would fail the whole turn, so the extras never leave this process.
    """
    return [{"role": m.get("role"), "content": m.get("content")}
            for m in hist if m.get("role") in ("user", "assistant") and m.get("content")]


def _last_touch():
    """When the conversation last moved, from the newest timestamp or the file's own mtime."""
    if HISTORY:
        newest = max((m.get("at") or 0) for m in HISTORY)
        if newest:
            return newest
    try:
        return os.path.getmtime(HISTORY_FILE)
    except Exception:
        return 0.0


def maybe_reset_idle():
    """Start a fresh conversation if the window has gone cold. Called at boot and each turn."""
    with HISTORY_LOCK:
        if not HISTORY:
            return False
        last = _last_touch()
        if not last or time.time() - last <= IDLE_RESET_SECONDS:
            return False
        idle = int((time.time() - last) / 60)
        close_session()                  # the window is kept before it is emptied
        try:
            tmp = HISTORY_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump([], f)
            os.replace(tmp, HISTORY_FILE)
        except Exception:
            pass
        print("conversation window: idle for %d minutes, starting fresh" % idle)
        return True


DEVICES_FILE = os.path.join(HERMES, "jarvis_live_devices.txt")
CODE_FILE = os.path.join(HERMES, "jarvis_tv_code.json")
CODE_TTL = 3600         # a pairing code lives an hour: a TV remote and an on-screen keyboard
                        # are slow, and five wrong tries lock an address anyway
TV_FAILS = {}           # ip -> [failure timestamps]
TV_FAILS_ALL = []       # every failure, whichever address it came from
TV_FAIL_WINDOW = 900
TV_FAIL_MAX = 5
TV_FAIL_MAX_ALL = 10    # rotating addresses defeat a per-address limit, so the code itself dies


DEVICES_LOCK = threading.RLock()
# One cookie lifetime for every route that signs a device in. Two values (a year on one path, thirty
# days on another) meant the same session expired at two different moments depending on how it was
# obtained. A year, and the server-side idle prune is the only thing that ends a session.
COOKIE_LIFETIME_DAYS = 365
COOKIE_MAX_AGE = COOKIE_LIFETIME_DAYS * 86400
DEVICE_PRUNE_DAYS = 90


def _tok_hash(tok):
    """What the device file stores for a token: sha256 of 32 url-safe characters. 24 random bytes is
    far beyond guessing; the hash is what makes a leaked file useless on its own."""
    return hashlib.sha256(str(tok or "").encode()).hexdigest()


def _is_hash(v):
    return bool(re.fullmatch(r"[0-9a-f]{64}", str(v or "")))


def _device_lines():
    try:
        with open(DEVICES_FILE, encoding="utf-8") as f:
            return [[p.strip() for p in ln.rstrip("\n").split("\t")]
                    for ln in f if ln.strip("\n")]
    except Exception:
        return []


def _device_write(lines):
    """Atomic, like every other store here. Six fields: token hash, label, scope, created,
    last seen, user id. A short row is padded, so an old line keeps its meaning."""
    tmp = DEVICES_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for parts in lines:
            p = list(parts) + [""] * (6 - len(parts))
            f.write("\t".join(p[:6]) + "\n")
    os.replace(tmp, DEVICES_FILE)


def device_entries():
    """Every paired device, parsed leniently.

    One per line, tab separated: token (hash, or a legacy plaintext), label, scope, created,
    last seen, user id. A line holding only a token is an entry from before scopes existed and is
    treated as full access, so nothing that works today stops working.
    """
    out = {}
    for parts in _device_lines():
        if not parts or not parts[0]:
            continue
        out[parts[0]] = {
            "label": parts[1] if len(parts) > 1 and parts[1] else "unnamed (legacy)",
            "scope": (parts[2] if len(parts) > 2 and parts[2] else "full"),
            "created": parts[3] if len(parts) > 3 else "",
            "last_seen": parts[4] if len(parts) > 4 else "",
            "user_id": parts[5] if len(parts) > 5 else "",
        }
    return out


def device_lookup(tok):
    """The row for a presented token, whether the file holds its hash or a legacy plaintext."""
    tok = str(tok or "")
    if not tok:
        return None, None
    entries = device_entries()
    if tok in entries and not _is_hash(tok):
        return tok, entries[tok]
    h = _tok_hash(tok)
    if h in entries:
        return h, entries[h]
    return None, None


_SEEN_DAY = {}                       # token hash -> the day last written, so the file is touched once a day
_REISSUE = {}                        # token hash -> the cookie should be re-issued on this response


def devices_touch(tok):
    """Stamp last_seen on a device that just authenticated, and migrate its row to a hash.

    Called from auth_scope, which runs on every request, so the day is cached in memory: the file is
    read once and written at most once a day per device.
    """
    h = _tok_hash(tok)
    today = time.strftime("%Y-%m-%d")
    if _SEEN_DAY.get(h) == today:
        return
    now = time.time()
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now))
    changed = False
    with DEVICES_LOCK:
        lines = _device_lines()
        for parts in lines:
            stored = parts[0] if parts else ""
            if stored != tok and stored != h:
                continue
            if stored == tok:
                parts[0] = h                      # migrate on first use, so nobody is signed out
                changed = True
            while len(parts) < 6:
                parts.append("")
            if parts[4][:10] != today:
                parts[4] = stamp
                changed = True
            break
        if changed:
            _device_write(lines)
        if changed:
            _REISSUE[h] = True               # last_seen moved: the cookie's life restarts with it
    _SEEN_DAY[h] = today



def device_tokens():
    return set(device_entries())


def add_device(label, scope, user_id=""):
    """Record a new device session and return its token.

    Only the hash is written. The token itself exists in the response that carries it and in the
    client's cookie, and nowhere on this machine.
    """
    tok = secrets.token_urlsafe(24)
    clean = " ".join(str(label or "device").split())[:40].replace("\t", " ")
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    row = [_tok_hash(tok), clean, scope, stamp, stamp, str(user_id or "")]
    try:
        with DEVICES_LOCK:
            lines = _device_lines()
            lines.append(row)
            _device_write(lines)
    except Exception as e:
        print("could not record the device: %s" % str(e)[:120])
    return tok


# --- device sessions: a readable name, and a list that stays honest -----------------------------------
_DEV_NAMES = [
    ("SM-A245", "Samsung Galaxy A24"), ("SM-A", "Samsung Galaxy A"), ("SM-S", "Samsung Galaxy S"),
    ("SM-G", "Samsung Galaxy"), ("Pixel", "Google Pixel"), ("CPH", "Oppo"), ("V2", "Vivo"),
    ("M2101", "Xiaomi"), ("Redmi", "Xiaomi Redmi"), ("iPhone", "iPhone"), ("iPad", "iPad"),
    ("Windows", "Windows PC"), ("Macintosh", "Mac"), ("X11; Linux", "Linux browser"),
]


def pair_label(request):
    """What a newly paired client is called: the friendlier of its own user agent and its form."""
    ua = request.headers.get("user-agent", "")
    name = ua_name(ua, short=True)
    return name if name and name != "unknown client" else "paired screen"


def ua_name(ua, short=False):
    """A client, named the way a person would name it.

    The raw user agent is kept for nobody: it is long, it is the same for every load from the same
    phone, and it made the session list unreadable. Model, system and platform are what identify a
    client here; where the agent is not recognised the trimmed string is better than an invention.
    """
    ua = str(ua or "").strip()
    if not ua:
        return "unknown client"
    dev = ""
    for frag, name in _DEV_NAMES:
        if frag in ua:
            dev = name
            break
    m = re.search(r"(?:SM-[A-Z]\d+|CPH\d+|M\d{4}[A-Z0-9]+|Pixel [0-9a-zA-Z ]+)", ua)
    model = m.group(0) if m else ""
    plat = ""
    a = re.search(r"Android (\d+)", ua)
    if a:
        plat = "Android " + a.group(1)
    elif "iPhone" in ua or "iPad" in ua:
        v = re.search(r"OS (\d+)_", ua)
        plat = "iOS " + (v.group(1) if v else "?")
    elif "Windows" in ua:
        plat = "Windows"
    elif "X11; Linux" in ua:
        plat = "Linux"
    elif "Macintosh" in ua:
        plat = "macOS"
    if dev and model and not re.search(r"\d", dev):
        dev = dev + " " + model      # a generic brand gets its model; a named one does not repeat it
    if not dev:
        dev = "Chrome" if "Chrome/" in ua and "Edg/" not in ua else ("Safari" if "Safari" in ua and "Chrome" not in ua else "browser")
        if "Edg/" in ua:
            dev = "Edge"
    if short:
        return (dev + (" (" + plat + ")" if plat else "")).strip()
    return (dev + (" \u00b7 " + plat if plat else "")).strip()


@app.middleware("http")
async def _refresh_reissued_cookie(request: Request, call_next):
    """A device whose last_seen just moved gets its cookie re-issued for the full lifetime.

    Then the only thing that ends a session is the server-side idle prune, not a browser quietly
    dropping a cookie it thinks is old.
    """
    resp = await call_next(request)
    try:
        tok = cookie_token(request)
        if tok and _REISSUE.pop(_tok_hash(tok), False):
            resp.set_cookie(COOKIE, tok, max_age=COOKIE_MAX_AGE, httponly=True, secure=True, samesite="lax")
    except Exception:
        pass
    return resp


def prune_devices(days=DEVICE_PRUNE_DAYS, reason="schedule"):
    """Drop devices that have not been seen for `days`, and any duplicate row for the same token.

    Age is measured from last_seen, falling back to created for a row written before last_seen
    existed. Duplication is decided on the token, not the label: two phones can carry the same label
    (a reduced user agent says "Chrome · Android 10" for every phone that uses it), and collapsing on
    the label deleted the second phone.
    """
    with DEVICES_LOCK:
        lines = _device_lines()
        if not lines:
            return {"before": 0, "after": 0, "revoked": 0}
        cutoff = time.time() - days * 86400
        keep, seen = [], set()
        for parts in reversed(lines):                     # newest first
            tok = parts[0].strip() if parts else ""
            if not tok:
                continue
            if tok in seen:
                continue                                  # the same token written twice
            seen.add(tok)
            stamp = ""
            if len(parts) > 4 and parts[4]:
                stamp = parts[4]
            elif len(parts) > 3:
                stamp = parts[3]
            try:
                when = time.mktime(time.strptime(stamp, "%Y-%m-%d %H:%M:%S")) if stamp else 0
            except Exception:
                when = 0
            if when and when < cutoff:
                continue                                  # not seen in `days`, by use or by creation
            keep.append(parts)
        keep.reverse()
        before = len(lines)
        if len(keep) == before:
            return {"before": before, "after": before, "revoked": 0}
        try:
            dest = os.path.join(HERE, "backups", "devices-prune-" + time.strftime("%Y%m%d-%H%M%S"))
            os.makedirs(dest, exist_ok=True)
            shutil.copy2(DEVICES_FILE, os.path.join(dest, "jarvis_live_devices.txt"))
        except Exception as e:
            print("prune: no safety copy: %r" % (e,))
        _device_write(keep)
    print("devices pruned (%s): %d -> %d" % (reason, before, len(keep)))
    return {"before": before, "after": len(keep), "revoked": before - len(keep)}


def migrate_devices_once():
    """One pass at startup: every plaintext token in the device file becomes its hash.

    Under the same lock every other writer takes, with a copy of the file taken first, and idempotent:
    a file that is already hashed is left alone. This is the migration; the per-request path only
    stamps last_seen.
    """
    with DEVICES_LOCK:
        lines = _device_lines()
        plain = [p for p in lines if p and p[0] and not _is_hash(p[0])]
        if not plain:
            return {"migrated": 0, "rows": len(lines)}
        try:
            dest = os.path.join(HERE, "backups", "devices-migrate-" + time.strftime("%Y%m%d-%H%M%S"))
            os.makedirs(dest, exist_ok=True)
            shutil.copy2(DEVICES_FILE, os.path.join(dest, "jarvis_live_devices.txt"))
        except Exception as e:
            print("devices migrate: no safety copy: %r" % (e,))
        for parts in lines:
            if parts and parts[0] and not _is_hash(parts[0]):
                parts[0] = _tok_hash(parts[0])
        _device_write(lines)
        print("devices migrated: %d plaintext row(s) hashed, %d row(s) kept" % (len(plain), len(lines)))
        return {"migrated": len(plain), "rows": len(lines)}


try:
    migrate_devices_once()
except Exception as _e:
    print("devices migration skipped: %r" % (_e,))

try:
    prune_devices(reason="startup")
except Exception as _e:                                     # a boot is not the place to raise
    print("startup prune skipped: %r" % (_e,))


# --- accounts, devices and sessions --------------------------------------------------------------------
# An account signs in; an account holds devices; a device holds sessions. The same phone is one device
# whether it opens the web app or the installed app, so a device is keyed by what the client IS (model and
# system), never by which surface it happened to arrive from, and never by the raw user agent.
#
# Sign-up is closed: this node serves one account, the owner's, and the file below is data rather than a
# hardcoded name so it can be changed without touching code.

ACCOUNTS_FILE = os.path.join(HERMES, "jarvis_live_accounts.json")
GOOGLE_WEB_FILE = os.path.join(HERMES, "jarvis_live_google.json")


def _load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _store_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def accounts():
    """Every account this node serves. One, seeded from the owner's own address, and no sign-up."""
    d = _load_json(ACCOUNTS_FILE, None)
    if not isinstance(d, dict) or not d.get("accounts"):
        d = {"accounts": {"owner@example.com": {"id": "acc_owner", "name": "Mohammad",
                                                 "role": "admin", "providers": ["email"],
                                                 "created": time.strftime("%Y-%m-%d %H:%M:%S")}},
             "signup": "closed"}
        try:
            _store_json(ACCOUNTS_FILE, d)
        except Exception as e:
            print("accounts: could not seed: %r" % (e,))
    return d


def account_for(email):
    return (accounts().get("accounts") or {}).get(str(email or "").strip().lower())


def device_key_for(ua):
    """What identifies the DEVICE, independent of the surface: model and system, not the agent string."""
    return ua_name(ua, short=False) or "unknown device"


def device_key_norm(label):
    """One device, one key.

    Rows written before the key became "model \u00b7 system" hold the display form ("model (system)"),
    and grouping on the raw string listed the same phone twice. Both forms normalise to the key.
    """
    t = str(label or "").strip()
    m = re.match(r"^(.*?) \((.*)\)$", t)
    if m:
        t = m.group(1).strip() + " \u00b7 " + m.group(2).strip()
    return t or "unknown device"


def device_display(key):
    return str(key or "unknown device").replace(" \u00b7 ", " (") + (")" if " \u00b7 " in str(key or "") else "")


def devices_summary(token=None):
    """Sessions grouped by device, which is the shape an account actually has."""
    key_of = {}
    rows = _session_rows()
    for r in rows:
        r["device"] = device_key_norm(r["device"])
        key_of.setdefault(r["device"], {"name": r["device"], "sessions": 0,
                                        "last": r.get("last_seen") or r.get("created"), "current": False})
        key_of[r["device"]]["sessions"] += 1
        cur = r.get("last_seen") or r.get("created") or ""
        if cur > (key_of[r["device"]]["last"] or ""):
            key_of[r["device"]]["last"] = cur
        if token and r["token"] == token:
            key_of[r["device"]]["current"] = True
    out = sorted(key_of.values(), key=lambda d: (d["last"] or ""), reverse=True)
    for d in out:
        d["display"] = device_display(d["name"])
    return out


def _session_rows():
    """The session file, in its own shape: token, device, scope, created, last seen."""
    entries = device_entries()
    return [{"token": t, "device": e.get("label") or "unknown device", "scope": e.get("scope") or "full",
             "created": e.get("created") or ""} for t, e in entries.items()]


def sessions_for_device(key):
    return [r for r in _session_rows() if r["device"] == key]


def report_devices():
    """Which devices hold a session, and which still rely on the master token.

    A device counts as still on the master token when it has no entry here: it is signing in with
    the master token itself, which cannot be revoked without logging it out.
    """
    entries = device_entries()
    print("paired devices: %d" % len(entries))
    for tok, e in entries.items():
        print("   %s...  %-24s scope=%-5s added %s" % (tok[:6], e["label"], e["scope"],
                                                       e["created"] or "unknown"))
    legacy = [t for t, e in entries.items() if e["label"] == "unnamed (legacy)"]
    if legacy:
        print("   %d entry(ies) predate scopes and count as full access" % len(legacy))
    print("   the master token itself is still accepted, so any device that has not signed in "
          "with a key still holds it and cannot be revoked individually")


def cookie_token(request: Request):
    for part in request.headers.get("cookie", "").split(";"):
        if "=" in part:
            k, v = part.strip().split("=", 1)
            if k == COOKIE:
                return v
    return ""


def auth_scope(request: Request):
    """None when not signed in, otherwise "master", "full" or "voice".

    The comparison is constant time: a leaked cookie or a URL in a log used to be permanent.
    """
    tok = cookie_token(request)
    if not tok:
        return None
    if hmac.compare_digest(tok, TOKEN):
        return "master"
    key, entry = device_lookup(tok)
    if entry is None:
        return None
    try:
        devices_touch(tok)            # last_seen once a day, and a legacy plaintext row becomes a hash
    except Exception as e:
        print("device touch skipped: %r" % (e,))
    return entry.get("scope") or "full"


def authed(request: Request):
    return auth_scope(request) is not None


RATE = {}                          # (device, kind) -> request times
RATE_LOCK = threading.Lock()
RATE_WINDOW = 300
RATE_MAX = 60                      # generous on purpose: a cost guard, not a nuisance


def rate_ok(request: Request, kind):
    """A per-device ceiling on the two endpoints that spend money."""
    who = cookie_token(request)[:8] or client_ip(request)
    now = time.time()
    with RATE_LOCK:
        hits = [t for t in RATE.get((who, kind), []) if now - t < RATE_WINDOW]
        hits.append(now)
        RATE[(who, kind)] = hits
        return len(hits) <= RATE_MAX


PUBLIC_HOST = os.environ.get("JARVIS_PUBLIC_HOST", "live.battemohammad.com")


def same_origin(request: Request) -> bool:
    """Refuse a request the browser says came from somewhere else.

    The cookie is SameSite=Lax, and a Lax cookie rides a cross-site top-level navigation, so
    without this a link Mohammad opens elsewhere can make this page run a turn — and the
    tool-using agent — with his cookie attached. Confirmed by measurement first: a request sent
    with Sec-Fetch-Site: cross-site was accepted and ran a whole turn.

    Browsers send Sec-Fetch-Site on every request. A browser old enough not to sets no such
    header, and then the Origin or Referer must match this host; a request with neither is
    refused, because a browser would always have supplied one.
    """
    site = request.headers.get("sec-fetch-site")
    if site is not None:
        return site in ("same-origin", "none")
    origin = request.headers.get("origin") or request.headers.get("referer") or ""
    if not origin:
        return False
    netloc = urllib.parse.urlparse(origin).netloc
    return netloc == request.headers.get("host", "") or netloc == PUBLIC_HOST


def client_ip(request: Request):
    """The caller's address, and never an address a caller can invent.

    The tunnel puts cloudflared in front of the app, so the socket peer is loopback for every
    visitor and a per-peer limit would be one bucket for the whole world. Cloudflare's own header
    is trusted only when the peer really is this machine; a direct request carrying a forged
    header is still keyed on the peer that opened the socket.
    """
    peer = ""
    try:
        peer = request.client.host if request.client else ""
    except Exception:
        peer = ""
    if peer:
        try:
            if ipaddress.ip_address(peer).is_loopback:
                hdr = (request.headers.get("cf-connecting-ip") or "").strip()
                if hdr:
                    try:
                        return str(ipaddress.ip_address(hdr))
                    except ValueError:
                        return peer
        except ValueError:
            pass
        return peer
    return "unknown"



def read_code():
    """The live pairing code, or empty when none is outstanding. Reading never mints, so a
    stranger hammering the endpoint cannot rotate the code out from under a pairing."""
    try:
        with open(CODE_FILE, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and float(d.get("expires", 0)) > time.time():
            return str(d.get("code", ""))
    except Exception:
        pass
    return ""


def mint_code():
    # secrets, not random: random is a predictable generator and this is an access code.
    d = {"code": "%06d" % secrets.randbelow(10 ** 6), "expires": time.time() + CODE_TTL}
    try:
        with open(CODE_FILE, "w", encoding="utf-8") as f:
            json.dump(d, f)
    except Exception:
        pass
    return d["code"]


def clear_code():
    try:
        os.remove(CODE_FILE)
    except Exception:
        pass


def tv_blocked(ip):
    now = time.time()
    fails = [t for t in TV_FAILS.get(ip, []) if now - t < TV_FAIL_WINDOW]
    TV_FAILS[ip] = fails
    return len(fails) >= TV_FAIL_MAX


def tv_fail(ip):
    now = time.time()
    TV_FAILS.setdefault(ip, []).append(now)
    TV_FAILS_ALL.append(now)
    recent = [t for t in TV_FAILS_ALL if now - t < TV_FAIL_WINDOW]
    TV_FAILS_ALL[:] = recent
    if len(recent) >= TV_FAIL_MAX_ALL:
        # Ten wrong codes across any addresses: the outstanding code is burned. Pairing again
        # needs a fresh mint, and minting is only reachable from the machine itself.
        clear_code()
        TV_FAILS_ALL[:] = []
        print("burned the outstanding pairing code: %d failed attempts" % len(recent))


GATE_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JARVIS</title>
<link rel="icon" href="/static/icon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
<link rel="manifest" href="/static/manifest.webmanifest">
<style>
 html,body{margin:0;height:100%%;background:#080b10;color:#e8eef7;
   font:400 20px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
 body{display:flex;align-items:center;justify-content:center;text-align:center}
 .w{max-width:560px;padding:48px 28px}
 h1{font-size:34px;font-weight:600;letter-spacing:.18em;margin:0 0 28px;color:#8fb8ff}
 p{color:#93a2b8;font-size:20px;margin:0 0 26px}
 input{width:320px;max-width:80vw;font-size:44px;letter-spacing:.3em;text-align:center;
   padding:16px 10px;border-radius:14px;border:1px solid #24344d;background:#0f1520;color:#fff}
 input:focus{outline:none;border-color:#4d7fd1}
 button{margin-top:22px;width:320px;max-width:80vw;font-size:22px;padding:16px;border:0;
   border-radius:14px;background:#2f6fd0;color:#fff;font-weight:600}
 .err{color:#ff9a9a;min-height:1.5em}
</style></head><body><div class="w">
<h1>JARVIS</h1>
<p>Enter the six digit code to pair this screen.</p>
<form method="post" action="/tv">
  <input name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6"
         autocomplete="off" autofocus aria-label="six digit code">
  <div><button type="submit">Pair this screen</button></div>
</form>
<p class="err">%(err)s</p>
</div></body></html>
"""


def gate(err="", ua=""):
    """Unauthenticated: the door. The pairing form lives on at /pair-screen as the way back in."""
    return door_page(message=err, ua=ua)


@app.get("/pair-screen", response_class=HTMLResponse)
def pair_screen():
    return HTMLResponse(GATE_HTML % {"err": ""})


def sse(event, data):
    data = _redact.redact_rows([data], ("d", "text", "line", "title", "message", "err", "q"))[0]
    return "event: %s\ndata: %s\n\n" % (event, json.dumps(data))


# Speech units: a sentence end, or a clause boundary once there are enough words for it to be
# worth saying on its own. One 34-word sentence took 7.5 seconds to make any sound because the
# whole sentence had to be synthesised first; measured, file-based speech costs 1.18s for ten
# words and 4.35s for twenty, so the unit length IS the delay. At clause size the first sound
# lands about when the first token does.
BOUNDARY = re.compile(r"(?<=[.!?])[\"')\]]?\s+|(?<=[,;:])\s+|\s+[\u2014\u2013]\s+")
UNIT_MIN_WORDS = 7
UNIT_MAX_WORDS = 20


def drop_partial_marker(text):
    """Remove the start of a control marker from a half-written reply.

    A reply cut off by the token limit ends mid-marker, and "[[WO" was otherwise spoken aloud.
    """
    return re.sub(r"\[\[?[A-Za-z]*$", "", text).rstrip()


def units(text):
    """Split into speakable units, keeping any tail. A unit is never shorter than a few
    words, so it does not sound clipped, and never longer than one breath."""
    out, rest = [], text
    while rest:
        cut = None
        for m in BOUNDARY.finditer(rest):
            if len(rest[:m.end()].split()) >= UNIT_MIN_WORDS:
                # A boundary too far away is not a boundary: without this, a single long
                # sentence with no commas becomes one enormous unit and the first sound waits
                # for the whole thing again, which is the defect being fixed.
                cut = m.end()
                if len(rest[:cut].split()) > UNIT_MAX_WORDS:
                    cut = None
                break
        if cut is None:
            words = list(re.finditer(r"\S+", rest))
            if len(words) > UNIT_MAX_WORDS:
                cut = words[UNIT_MAX_WORDS - 1].end()      # no boundary: break at a breath
            else:
                break
        out.append(rest[:cut].strip())
        rest = rest[cut:].lstrip()
    return out, rest.strip()


def fish_stream(text):
    body = json.dumps({"text": text, "reference_id": VOICE, "format": "mp3",
                       "latency": "balanced", "chunk_length": 150,
                       "temperature": 0.7, "top_p": 0.7, "normalize": True,
                       "prosody": {"speed": SPEED}}).encode()
    req = urllib.request.Request(
        "https://api.fish.audio/v1/tts", data=body,
        headers={"Authorization": "Bearer " + FISH_KEY, "Content-Type": "application/json",
                 "model": FISH_MODEL})
    with urllib.request.urlopen(req, timeout=120) as resp:
        # read1 returns whatever the socket already holds rather than waiting to fill an 8KB
        # buffer, so the head of the audio leaves for the phone as soon as it exists.
        while True:
            chunk = resp.read1(8192) if hasattr(resp, "read1") else resp.read(8192)
            if not chunk:
                return
            yield chunk


PROGRESS_SYSTEM = (
    "You are JARVIS, still working on the request below. Write ONE spoken sentence of five "
    "to twelve words saying what HAS happened. Use only the facts you are given. Never say "
    "what you can or cannot do. Never say what has not happened, is not ready, is not up "
    "yet, or is still coming: silence is better than a report of an absence. Never mention "
    "his screen unless something is on it. If there is nothing true and new to say, output "
    "NONE. Do not use stock phrases; those sound like a machine. Do not repeat a line "
    "already used. Output the sentence alone."
)

# A progress line that claims a limit is the defect this whole path exists to remove: the model
# cannot see the tools, so any sentence about what it can or cannot do is invented. Discard it
# rather than speak it. Measured cause: with no facts in the prompt it wrote "not something I can
# render directly" while the portrait was already on the screen.
NO_CAPABILITY = re.compile(r"\b(can(?:'t|not| ?not)|unable|not something I can|don't have|"
                           r"do not have|no way to|isn't possible|not possible)\b", re.I)

# A line that reports an ABSENCE is the same defect wearing different clothes: asked for a panel
# that has not been pushed yet, the writer says "the panel isn't up yet" or "nothing is ready".
# It has nothing true to add, so it narrates the gap. Measured on a live turn: three lines in a
# row, all of them this shape. The facts are positive only, so a line about what is missing is
# discarded and the turn simply stays quiet until there is something to say.
NO_ABSENCE = re.compile(r"\b(is ?n[o']t|aren't|wasn't|hasn't|haven't|didn't|won't|not yet|"
                        r"nothing|yet to|still waiting|still coming|still working|pending|"
                        r"blank|empty)\b", re.I)


def progress_line(question, used, facts=None, shown=None):
    """One line while the agent works, built from what has ACTUALLY happened.

    The model sees only the question and its own earlier lines, so on its own it invents both the
    work and the limits: it once said a panel was "still being plotted" while that panel was on
    the screen in front of him. Feed it the real facts and the claim disappears.
    """
    try:
        happened = "; ".join(facts or []) or "none"
        # An empty screen is passed as an instruction, not as a fact to talk about. Handed the
        # word "nothing" as data, the model reported it: measured on a live turn, every line said
        # some version of "your screen is still empty".
        screen_line = ("On his screen now: %s" % "; ".join(shown)) if shown else \
                      "Nothing has been put on his screen yet. Do not mention the screen."
        # 60 tokens of max_tokens all went to the model's reasoning, so this returned an empty
        # line EVERY time (measured 0 of 6) and a delegated answer played its opening line and
        # then sat in silence for the whole agent run. Measured with thinking off: 4 of 4.
        body = json.dumps({"model": FRONT_MODEL, "stream": False, "max_tokens": 200,
                           "thinking": {"type": "disabled"},
                           "messages": [{"role": "system", "content": PROGRESS_SYSTEM},
                                        {"role": "user",
                                         "content": "His request: %s\nWhat has actually "
                                                    "happened: %s\n%s\n"
                                                    "Lines already used: %s"
                                                    % (question, happened, screen_line,
                                                       "; ".join(used) or "none")}]}).encode()
        req = urllib.request.Request("https://api.deepseek.com/chat/completions", data=body,
                                     headers={"Content-Type": "application/json",
                                              "Authorization": "Bearer " + DS_KEY})
        with urllib.request.urlopen(req, timeout=30) as resp:
            txt = json.loads(resp.read())["choices"][0]["message"]["content"].strip()
        txt = re.sub(r"^[\-•*\d.\s]+", "", txt).strip().strip('"')
        if not (3 < len(txt) < 160) or txt.strip().upper().startswith("NONE"):
            return ""
        if NO_CAPABILITY.search(txt):
            print("progress line dropped: it claimed a limit: %s" % txt[:80])
            return ""
        if NO_ABSENCE.search(txt):
            print("progress line dropped: it reported an absence: %s" % txt[:80])
            return ""
        return txt
    except Exception:
        return ""


def shape_hint(mode, prompt):
    """A typed question that wants structure says so, even to the layer that answers in prose.

    Attached to his message rather than added to the system prompt: that prompt is the long shared
    prefix, and keeping it byte-identical is what lets the provider's prefix cache work.
    """
    if mode != "text":
        return ""
    return ("\n\n[" + TEXT_MODE_NOTE + " " + TEXT_MECHANICS +
            " Supported display library: " + UI_LIBRARY + "]" + RESPONSE_LAYER.prompt_note())


def front_stream(prompt, history=None, mode="voice", network=True, on_event=None, require_web=False, reasoning="none", stop=None, on_diagnostic=None):
    if mode == "text":
        raise RuntimeError("text answers require the harness-owned page adapter")
    ident = identity()
    system = system_for(mode) + ("\n\n" + ident if ident else "")
    prior = recall() if history is None else history
    messages = ([{"role": "system", "content": system}] + for_model(prior)
                + [{"role": "user", "content": prompt + "\n\n" + now_line() + shape_hint(mode, prompt)}])
    # max_tokens covers the model's REASONING as well as its words, and reasoning is not
    # streamed, so a low cap fails silently: measured on ten substantive questions, six came
    # back with reasoning_tokens=500, finish_reason=length and an EMPTY reply, and the page
    # then said nothing at all. Short spoken questions rarely reach it, which is why a typed
    # question broke while a spoken one did not.
    body = json.dumps({"model": FRONT_MODEL, "stream": True, "max_tokens": 2000,
                       "thinking": {"type": "disabled"},
                       "messages": messages}).encode()
    req = urllib.request.Request("https://api.deepseek.com/chat/completions", data=body,
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + DS_KEY})
    with urllib.request.urlopen(req, timeout=120) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "ignore").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                return
            try:
                d = json.loads(payload)["choices"][0].get("delta", {}).get("content") or ""
            except Exception:
                continue
            if d:
                yield d


# Runtime notices: these phrases never occur in real speech, so match them anywhere.
NOISE_WORDS = ("normalized model", "model restored", "resumed session", "session_id",
               "using model", "tool_call", "function call", "exit code")

# Status-line openers. These are ordinary English words, so they count as noise only at the
# START of a line. Matching them anywhere deleted real prose: a news sentence about Museveni
# "calling on Ugandans" was silently dropped and the whole answer came back empty.
NOISE_PREFIX = re.compile(r"^\s*(?:running|executing|fetching|calling|warning|note|error)\b[:\s]",
                          re.I)
NOISE = re.compile(r"^\s*(?:[^\w\s]{1,4}\s*)?(?:\{|\[|\"|')")


# Model tool-call / control markup. The fast layer emitted DSML tool syntax and it was
# read aloud as "DSML calls invoke name web search". This is machinery, not language:
# none of it may reach the page or the voice, ever.
MARKUP = re.compile(
    r"(?:\|\||\uff5c\uff5c|<\|)\s*DSML"
    r"|<\|?\s*(?:tool_calls?|function_calls?)|</?\s*(?:invoke|parameter|function_calls|antml)"
    r"|<<<\s*SPOKEN|SPOKEN\s*>>>",
    re.I)


def is_markup(junk):
    return bool(MARKUP.search(junk))


def speakable(line):
    """A line earns its place in the spoken reply only if it reads as prose."""
    t = line.strip()
    low = t.lower()
    if not t or NOISE.match(t) or is_markup(t):
        return False
    if any(w in low for w in NOISE_WORDS):          # anywhere: these cannot be prose
        return False
    if NOISE_PREFIX.match(t):                       # only as a leading status line
        return False
    if re.search(r"(?i)session_id|\\u|https?://|/home/|\.py\b|\balerts?\b.*\|", t):
        return False
    words = t.split()
    if len(words) < 3:
        return False
    letters = sum(ch.isalpha() or ch.isspace() for ch in t)
    if letters / max(1, len(t)) < 0.72:                        # mostly punctuation/emoji
        return False
    return True


# The marker must start its own line, or an agent that echoes the instruction back in prose
# ("put it between <<<SPOKEN and SPOKEN>>>") would have the words between them spoken.
SPOKEN_RE = re.compile(r"^<<<SPOKEN\s*(.*?)\s*SPOKEN>>>", re.S | re.M)
# A fenced block, opener line included, so whitespace inside it can be left alone.
FENCE_RE = re.compile(r"```[^\n]*\n.*?(?:```|\Z)", re.S)
URL_RE = re.compile(r"https?://([^\s/,;)]+)\S*")
PATH_RE = re.compile(r"(?:/[\w.\-]+){2,}/?")
# A delivery directive is an instruction for the channel, not a sentence for a person. Repairing
# only the path out of one left the directive head standing, and produced the worst answer this
# page has ever spoken: asked to read the news, the agent wrote its media line, PATH_RE turned the
# path into the words "that file", and the page said "MEDIA:that file" out loud as the whole reply.
DELIVERY_LINE_RE = re.compile(
    r"(?:^|\n)[ \t]*(?:MEDIA|VOICE|AUDIO|ATTACH|ATTACHMENT|FILE|IMAGE|VIDEO)\s*:[^\n]*", re.I)
DELIVERY_TOKEN_RE = re.compile(
    r"\b(?:MEDIA|VOICE|AUDIO|ATTACH|ATTACHMENT|IMAGE|VIDEO)\s*:\s*\S+", re.I)
# A double-bracket token is channel syntax and is stripped before he reads it — except the file
# marker, which is the page's own and has to survive to the screen. Stripping it was why an answer
# that produced a file arrived with no file in it.
TAG_RE = re.compile(r"\[\[(?!file:)[^\]]*\]\]|\{\{[^}]*\}\}")


def strip_delivery(text):
    """Remove anything addressed to the channel rather than to him.

    Two shapes, because they need different reach: a directive that owns its line takes the whole
    line (a leftover fragment read as the answer is exactly the bug this exists to kill), while one
    sitting inside a sentence takes only the token it names.
    """
    t = DELIVERY_LINE_RE.sub("\n", text or "")
    t = DELIVERY_TOKEN_RE.sub("", t)
    t = TAG_RE.sub("", t)
    return t


def extract_spoken(out):
    """The spoken reply, from between the sentinels the agent is told to use."""
    found = SPOKEN_RE.findall(out or "")
    return found[-1].strip() if found else None


def repair_line(line):
    """Repair rather than reject.

    A URL becomes its host, a file path is removed, markdown and emoji go, and the line is kept.
    The old filter deleted whole lines for any of those, and the agent answers in one line, so one
    URL could delete the entire answer.
    """
    t = URL_RE.sub(lambda m: m.group(1), line or "")
    # "that file" rather than nothing: a bare deletion left "Your ledger is at and totals ..."
    t = PATH_RE.sub("that file", t)
    t = re.sub(r"[\U0001F300-\U0001FAFF\u2600-\u27BF\uFE0F\u200B]", "", t)
    t = re.sub(r"[*_`#>|]+", "", t)
    t = re.sub(r"\s{2,}", " ", t)
    return t.strip()


def tidy_reply(text):
    """Collapse the loose whitespace of prose, and leave a fenced block exactly as written.

    A blanket whitespace collapse was applied to the whole reply. Every newline that preceded an
    indent is two or more whitespace characters, which is every line of an indented code block, so a
    nine-line function reached his screen as two lines and stopped being code. A fence is the one
    region where whitespace is the content, so it is skipped rather than tidied.
    """
    def loose(t):
        return re.sub(r"[ \t]{2,}", " ", re.sub(r"\n{3,}", "\n\n", t))
    out, pos = [], 0
    for m in FENCE_RE.finditer(text or ""):
        out.append(loose((text or "")[pos:m.start()]))
        out.append(m.group(0))
        pos = m.end()
    out.append(loose((text or "")[pos:]))
    return "".join(out).strip()


def _p3trace(raw, screen, out, sentinels):
    """Record what the agent wrote beside what the page is given, when tracing is switched on.

    Comparing the two is the only way to tell a component the model never wrote from one my own
    processing threw away. Off unless the trace folder exists.
    """
    try:
        d = "/data/apps/jarvis-live/.p3trace"
        if not os.path.isdir(d):
            return
        rec = {"ts": datetime.datetime.now().strftime("%H:%M:%S"),
               "screen": bool(screen), "sentinels": bool(sentinels),
               "raw_len": len(raw or ""), "out_len": len(out or ""),
               "raw": (raw or "")[:12000], "out": (out or "")[:12000]}
        with open(os.path.join(d, "turns.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
    except Exception:
        pass


# The one marker the page reads back. It is a line of its own and it is entirely bracketed, which
# is exactly the shape the JSON-blob guard below throws away.
OUTBOX_MARK = re.compile(r"^\[\[file:[^\]\n]+\]\]$")


def spoken_from_output(out, screen=False):
    """Return (spoken_text, used_sentinels).

    `screen` is the reading path: when the agent forgets its sentinels the reply is still repaired
    for speech by default, and that repair deletes every mark, pipe and brace on the way: headings,
    bold, tables and whole component specs. He is reading, not listening, so the words are kept as
    written and only noise lines are dropped.
    """
    # Both paths get this: the sentinel block used to be returned exactly as the agent wrote it,
    # so a directive inside the sentinels reached his ear untouched.
    raw = out
    out = strip_delivery(out)
    block = extract_spoken(out)
    if block is not None:
        res = tidy_reply(strip_delivery(block))
        _p3trace(raw, screen, res, True)
        return res, True
    kept = []
    for line in (out or "").splitlines():
        # The notice check runs on the RAW line: repairing strips underscores, which turned
        # "session_id" into "sessionid" and let it through.
        low = (line or "").lower()
        if any(w in low for w in NOISE_WORDS):          # cannot occur in speech
            continue
        if is_markup(line or ""):
            continue
        t = line if screen else repair_line(line)
        if not t or not re.search(r"[A-Za-z0-9]", t):
            continue
        if is_markup(t):                                # control markup, including the sentinels
            continue
        if re.fullmatch(r"[\[{].*[\]}]\s*", t) and not OUTBOX_MARK.match(t.strip()):
            continue                                  # a JSON blob on its own, but never a file marker
        kept.append(t)
    res = ("\n".join(kept) if screen else " ".join(kept)).strip()
    _p3trace(raw, screen, res, False)
    return res, False


def scrub(line):
    """Strip anything that would be read aloud as gibberish."""
    line = re.sub(r"[\U0001F300-\U0001FAFF\u2600-\u27BF\uFE0F\u200B\u2022]", "", line)
    for junk in ("**", "`", "⚠️", "✅", "🔹", "•", "—  "):
        line = line.replace(junk, "")
    if is_markup(line):
        return ""
    line = re.sub(r"</?[^>\s]{0,40}>", "", line)        # stray xml-ish tags
    line = re.sub(r"[\uff5c|]{2,}", "", line)            # runs of pipes / fullwidth bars
    line = re.sub(r"\s{2,}", " ", line)
    return line.strip() if speakable(line) else ""


def _line_scrubber(stream, sink=None):
    """Pass a stream through, scrubbing only at line boundaries.

    Judging fragments is what leaked 'epeek-flash' into the reply: a runtime notice
    arrives split across chunks, so each piece looked like ordinary text.
    """
    buf = ""
    for chunk in stream:
        buf += chunk
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            clean = scrub(line)
            if clean:
                if sink is not None:
                    sink.append(clean)
                yield clean + " "
    if buf.strip():
        clean = scrub(buf)
        if clean:
            if sink is not None:
                sink.append(clean)
            yield clean


# Overridable so the failure paths can be driven deliberately in a test (item 2 verify: an
# unreachable binary, a timeout, an empty answer) without touching the live service.
HERMES_BIN = os.environ.get("JARVIS_HERMES_BIN") or os.path.join(HERMES, "hermes-agent/venv/bin/hermes")
WORKDIR = "/data/apps/jarvis-live"


# The agent is given its own wall-clock budget, and at 80% of it the agent itself is told to wrap up,
# so a long turn ENDS with an answer instead of this process cutting it off with nothing. Measured
# cause: a widget-building turn ran 280.1 seconds, this ceiling killed it at 280, and the page spoke
# "That one ran long" over a screen that already had the finished widget on it. The outer number is
# now only a backstop above the agent's own budget, so the agent decides when it has finished.
AGENT_RUN_BUDGET = 420.0     # handed to the agent as --run-budget; it is told to wrap up at 80%
AGENT_TIMEOUT = 480.0        # this process's backstop, deliberately above the agent's own budget

AGENT_CUES = {"failed": "agentfailed", "timeout": "agenttimeout", "empty": "agentempty"}
AGENT_SAYS = {"failed": "I could not reach the agent just now, sir.",
              "timeout": "That one ran long, sir. Ask me again and I will keep it shorter.",
              "empty": "I got nothing back on that, sir. Ask me once more."}


FALLBACK_COUNT = [0]


# --- the warm agent ---------------------------------------------------------------------------
# Every turn used to spawn a fresh agent process and wait for Python, the config, eight MCP
# servers and the session to come up. Measured 15 Oct 2026: 21.5 seconds to the first word on a
# work turn, and that build was the whole of it. One long-lived process is built once and reused,
# so the build is paid once instead of on every question. Anything unexpected falls back to the
# cold spawn below, unchanged.
try:
    from warm_agent import WarmAgent
except Exception as _warm_import_error:
    WarmAgent = None
    print("warm agent unavailable: %r" % (_warm_import_error,))

WARM_PRESTART = threading.local()       # reset request hint; never changes the stored window id
WARM_AGENTS = {}
WARM_LOCK = threading.Lock()
WARM_FAILURES = {}                       # session name -> consecutive failures (the breaker)
WARM_ENABLED = os.environ.get("JARVIS_WARM_AGENT", "1") != "0"
WARM_IDLE_SECONDS = float(os.environ.get("JARVIS_WARM_IDLE", "1800"))
WARM_BUILD_TIMEOUT = float(os.environ.get("JARVIS_WARM_BUILD_TIMEOUT", "600"))
WARM_READY_WAIT = float(os.environ.get("JARVIS_WARM_READY_WAIT", "25"))


def warm_agent(session_name):
    """The warm process for this session name, built on first use."""
    if not WARM_ENABLED or WarmAgent is None:
        return None
    with WARM_LOCK:
        agent = WARM_AGENTS.get(session_name)
        if agent is None:
            # One process at a time: a rotated session name would leave an older one running.
            for other, old in list(WARM_AGENTS.items()):
                if (other != session_name and other not in WARM_BUILDING
                        and not old.busy() and old.idle_for() > WARM_IDLE_SECONDS):
                    old.close()
                    WARM_AGENTS.pop(other, None)
            agent = WarmAgent(HERMES_BIN, WORKDIR, session_name, model=config_model(),
                              idle_seconds=WARM_IDLE_SECONDS, timeout=AGENT_TIMEOUT,
                              ctx_path=os.path.join(HERE, "ctx", session_name + ".json"))
            WARM_AGENTS[session_name] = agent
            # One conversation keeps its agent; two at most. A third chat is not worth another ~700 MB on
            # this machine, and the one that has been idle longest is the one to give up.
            while len(WARM_AGENTS) > 2:
                candidates = [(n, a) for n, a in WARM_AGENTS.items()
                              if n != session_name and n not in WARM_BUILDING and not a.busy()]
                if not candidates:
                    WARM_AGENTS.pop(session_name, None)
                    agent.close()
                    return None
                oldest = max(candidates, key=lambda kv: kv[1].idle_for())
                try:
                    oldest[1].close()
                except Exception:
                    pass
                WARM_AGENTS.pop(oldest[0], None)
        return agent


WARM_BUILDING = set()          # session names with a build already running
WARM_BUILD_LOCK = threading.Lock()


def _warm_build(name):
    """Build once for the page-owned name; retain failures for the next decision."""
    watchdog = None
    try:
        agent = warm_agent(name)
        if agent is None:
            return
        watchdog = threading.Timer(WARM_BUILD_TIMEOUT, agent.hard_close)
        watchdog.daemon = True
        watchdog.start()
        if not agent.ensure_ready():
            raise RuntimeError(getattr(agent, "last_build_error", "") or "session build returned false")
        WARM_FAILURES[name] = 0
        print("warm agent build ready: %s" % name, flush=True)
    except Exception as exc:
        WARM_FAILURES[name] = WARM_FAILURES.get(name, 0) + 1
        print("ERROR warm agent build failed: name=%s reason=%s" %
              (name, _redact.redact(str(exc))[:400]), flush=True)
    finally:
        if watchdog is not None:
            watchdog.cancel()
        with WARM_BUILD_LOCK:
            WARM_BUILDING.discard(name)


def warm_prewarm_for(name=None):
    """Queue the named build; a failed cached object is retryable, not already warm."""
    if not WARM_ENABLED or WarmAgent is None:
        return False
    name = name or agent_session_name()
    with WARM_BUILD_LOCK:
        agent = WARM_AGENTS.get(name)
        if name in WARM_BUILDING or (agent is not None and agent.ready()):
            return False
        WARM_BUILDING.add(name)
    try:
        threading.Thread(target=_warm_build, args=(name,), daemon=True).start()
    except Exception as exc:
        with WARM_BUILD_LOCK:
            WARM_BUILDING.discard(name)
        print("ERROR warm agent build could not start: %s" % _redact.redact(str(exc))[:400], flush=True)
        return False
    return True


def warm_prewarm():
    """Warm the conversation he is actually in, if this process knows its name.

    Before the first turn no name is minted, and a build for a placeholder cannot be reused by any
    turn: it held a process for nothing while the first real turn paid for its own.
    """
    if not SESSION.get("id"):
        print("warm agent pre-start skipped: no conversation name yet")
        return
    warm_prewarm_for(agent_session_name())


def _warm_events(on_event, screen=False):
    """Mirror this file's own stream vocabulary onto the warm agent's events."""
    state = {"tool": "", "narr": [], "all": "", "emitted": 0}

    def flush_narration():
        if not on_event or not state["narr"]:
            return
        line = " ".join(strip_delivery("".join(state["narr"])).split())
        line = re.sub(r"^[#*\- >\s]+", "", line).strip()
        state["narr"].clear()
        if 3 < len(line) <= 110:
            on_event("note", "", line)

    def emit(kind, payload):
        if kind == "tool_use":
            flush_narration()
            state["tool"] = str(payload.get("name") or "tool")
            inp = payload.get("input") or {}
            if on_event:
                on_event("run", state["tool"], tool_line(state["tool"], inp), None,
                         title=tool_title(state["tool"], inp))
        elif kind == "tool_result":
            who = str(payload.get("name") or state["tool"] or "tool")
            if on_event:
                on_event("ok" if not payload.get("is_error") else "err", who,
                         tool_detail(payload.get("output")), payload.get("duration_ms"))
        elif kind == "text":
            piece = str(payload.get("text") or "")
            if not piece:
                return
            state["all"] += piece
            if not on_event:
                return
            # The reply sits between <<<SPOKEN and SPOKEN>>>; anything outside them is the agent's
            # own running commentary, gathered into a line before it is handed over.
            if state["all"].rfind("<<<SPOKEN") != -1:
                state["narr"].clear()
                if screen:
                    body = state["all"].split("<<<SPOKEN", 1)[1]
                    end = body.find("SPOKEN>>>")
                    visible = body[:end] if end >= 0 else body[:-len("SPOKEN>>>")]
                    delta = visible[state["emitted"]:]
                    if delta:
                        state["emitted"] += len(delta)
                        on_event("live", "", delta)
            else:
                state["narr"].append(piece)
                buffered = "".join(state["narr"])
                if not re.search(r"<{1,3}$", buffered):
                    if re.search(r"[.!?:]\s*$", buffered) or "\n" in buffered or len(buffered) >= 90:
                        flush_narration()
    return emit


def warm_build_in_background(session_name, agent):
    """Use the same build coordinator as pre-start."""
    return warm_prewarm_for(session_name)


def _guard_path(path, conv, note=""):
    """One line per web turn saying which route it took. The health check reads these."""
    try:
        import json as _json, time as _time
        rec = {"ts": round(_time.time(), 3), "path": path, "conv": str(conv or ""), "note": note}
        with open(os.path.join(HERE, "logs", "web_guard.log"), "a", encoding="utf-8") as f:
            f.write(_json.dumps(rec) + "\n")
    except Exception:
        pass


# What the page can draw. A number the reader will want to change, or a choice between options,
# belongs on the page as a card, not in a file and not in prose that describes a control nobody can
# touch. So: emit one complete fenced ui block holding a JSON object, and never write an HTML file or
# a script for a calculator. Templates need only component, fallback and optional initial values:
# quote-estimator (quantity, price, discount), bill-splitter (bill, people, tip), budget-planner
# (income, housing, food, other). table, chart, map, quiz and diagram need their outputs declared.
# Never tell the reader to drag or tap anything that is not in the answer.


@OPENUI.agent_result
def warm_answer(ask, stop=None, on_event=None, reasoning="none", screen=False, conv=None):
    """Ask the warm agent. Returns (status, spoken), or None to use the cold spawn instead."""
    name = agent_session_name(conv)
    if WARM_FAILURES.get(name, 0) >= 2:
        return None                      # the breaker: twice bitten, stop paying for it
    try:
        agent = warm_agent(name)
        if agent is None:
            return None
        if not agent.ready():
            # Not built yet: the first turn after a restart or a rotation. Falling back to a cold
            # spawn cost this turn a whole process start anyway AND threw away the build already
            # running, so waiting for that same build is never the slower choice.
            warm_build_in_background(name, agent)
            _deadline = time.time() + WARM_READY_WAIT
            while time.time() < _deadline:
                if stop and stop():
                    return ("stopped", "")
                if agent.ready():
                    break
                if getattr(agent, "last_build_error", "") and name not in WARM_BUILDING:
                    break
                time.sleep(0.15)
            if not agent.ready():
                return None
        options = {"retry": False} if screen else {}
        _response = globals().get('RESPONSE_AUTHORING')
        if _response and getattr(agent, 'ctx_path', None):
            _response.SOURCES.bind_publisher(agent.ctx_path)
        status, raw = agent.ask(ask, on_event=_warm_events(on_event, screen=screen),
                                stop=stop, reasoning=reasoning, **options)
    except Exception as exc:
        print("warm agent turn failed: %r; using a cold turn" % (exc,))
        WARM_FAILURES[name] = WARM_FAILURES.get(name, 0) + 1
        return ("failed", "") if screen else None
    if status in ("failed", "timeout"):
        print("warm agent returned %s; using a cold turn" % status)
        WARM_FAILURES[name] = WARM_FAILURES.get(name, 0) + 1
        return (status, "") if screen else None
    WARM_FAILURES[name] = 0
    if status == "stopped":
        return ("stopped", "")
    spoke, via_sentinels = spoken_from_output(raw, screen=screen)
    if not via_sentinels:
        FALLBACK_COUNT[0] += 1
        print("agent did not use the sentinels (%d times so far)" % FALLBACK_COUNT[0])
    return ("ok", spoke) if spoke.strip() else ("empty", "")


def tool_line(name, inp):
    """One readable line for a tool call, in his terms rather than the tool's."""
    if not isinstance(inp, dict):
        return str(inp)[:200]
    for key in ("command", "query", "url", "pattern", "path", "prompt", "text"):
        v = inp.get(key)
        if isinstance(v, str) and v.strip():
            return " ".join(v.split())[:200]
    bits = []
    for k, v in inp.items():
        if isinstance(v, (str, int, float, bool)):
            bits.append("%s=%s" % (k, " ".join(str(v).split())[:60]))
    if bits:
        return ", ".join(bits)[:200]
    # The runtime sometimes hands the work over inside the tool's NAME and sends no arguments, so
    # there is nothing above to read. A tail that names a thing (a file, a path, a host, a query) is
    # then the target and belongs here; a tail that is prose is already the row's title, and
    # repeating it underneath would print the same sentence twice.
    raw = str(name or "")
    tail = raw.split(":", 1)[1].strip() if ":" in raw else ""
    tail = " ".join(tail.split()).strip("'\" ")
    if not tail:
        return ""
    if re.match(r"https?://|www\.", tail, re.I) or not re.search(r"\s", tail):
        return tail[:200]
    # A command's own first word is a program and never capitalised; prose opening on a capital is
    # the row's title already. That single test tells the two apart without a list of either.
    if tail[:1].islower():
        return tail[:200]
    return ""


def _object_title(low, inp):
    """A title naming what the call worked on, taken from the one argument that names it.

    Repeating a broad file label six times is the same defect as repeating any generic action: a trace he cannot
    read. Where the call names its object, that name is the title he sees, so a scan of six files
    reads as six different things rather than six identical chips.
    """
    if not isinstance(inp, dict):
        return None

    def arg(*names):
        for n in names:
            v = inp.get(n)
            if isinstance(v, str) and v.strip():
                return " ".join(v.split())
        return ""

    def short(s, n=52):
        return s if len(s) <= n else s[:n - 1].rstrip() + "\u2026"

    def base(p):
        g = p.rstrip("/").split("/")[-1]
        return g or p

    def kind(p):
        # A name is an identifier, not prose. Rewriting its underscores or hyphens into spaces turned
        # "phone_compare.json" into "phone compare.json", which is a file that does not exist. Only the
        # words around a name get humanised; the name itself is shown as it is spelled.
        leaf = base(p).strip()
        return "the %s %s" % (short(leaf, 32), "file" if "." in base(p) else "folder")

    def a_page(url):
        return "the page at " + (urllib.parse.urlparse(url).hostname or "the web")

    def query_words(value):
        # A glob or a path is not a query: "**/*.py" would come out as "the py query".
        if re.search(r"[*?\\/]|^[^\w]*$", value):
            return ""
        words = re.findall(r"[A-Za-z0-9]+", value)[:5]
        return "the %s query" % " ".join(words) if words else ""

    table = {
        # A tool's argument names vary by family (path / file_path / filename / target), so every
        # spelling that names the same thing is accepted: a step that lost its object falls back to
        # a bare verb, which is the vagueness this table exists to remove.
        "read file":    (("path", "file", "file_path", "filepath", "filename", "target", "name"), "Read %s", kind),
        "write file":   (("path", "file", "file_path", "filepath", "filename", "target", "name"), "Wrote %s", kind),
        "patch":        (("path", "file", "file_path", "filepath", "filename", "target", "name"), "Edited %s", kind),
        "str replace":  (("path", "file", "file_path", "filepath", "filename", "target", "name"), "Edited %s", kind),
        "search files": (("pattern", "query", "q", "search", "text"), "Searched for %s", query_words),
        "web search":   (("query", "q", "search", "text", "terms"), "Searched for %s", query_words),
        "web extract":  (("url", "uri", "link", "page", "href"), "Read %s", a_page),
        "browser exec": (("url", "uri", "link", "page", "href"), "Opened %s", a_page),
        "screen show":  (("label", "title"), "Rendered %s", lambda v: short(v, 58)),
        "delegate task": (("goal", "task"), "Handed work to a helper", lambda _: ""),
    }
    row = table.get(low)
    if not row:
        return None
    keys, fmt, shape = row
    v = arg(*keys)
    if not v:
        return None
    shaped = shape(v)
    if "%s" in fmt:
        # A verb with nothing after it ("Searched for") is the same vagueness this table exists to
        # remove, and it appears whenever the argument cannot be shaped into words (a bare glob, a
        # dot). Fall through to the verb table rather than print half a sentence.
        if not str(shaped or "").strip():
            return None
        return fmt % shaped
    return fmt


def tool_title(name, inp):
    """A short human sentence for one tool call, for the Summary sheet.

    Claude-style tools carry a `description` written for a person; use it when it is there. Every
    other tool gets a title built from its own name and the one argument that names the work.
    """
    def clean_sentence(value):
        sentence = " ".join(str(value or "").split()).rstrip(".!?;:")
        command_syntax = re.search(r"(^|\s)terminal\s*:|(^|\s)(sudo|echo|cd|ls|cat|grep|rg|find|curl|wget|python3?|node|npm|git|bash|sh)(\s|$)|(^|\s)/[^\s]+|\$|&&|\||;|`|=>|[{}]|[\"'][^\"']{2,}[\"']|\b[A-Za-z_$][\w$]*\s*=\s*[^=]", sentence, re.I)
        return None if command_syntax else sentence

    if isinstance(inp, dict):
        d = inp.get("description")
        if isinstance(d, str) and d.strip():
            clean = clean_sentence(d)
            if clean:
                return clean
    raw_name = str(name or "tool")
    words = re.sub(r"[_\-]+", " ", raw_name).strip()
    # An agent may name the shell tool after the work it did ("terminal: df -h / /data"), so the
    # call's own command can arrive inside the tool's name. The command is not the tool: keep the
    # word before the first colon and drop a summariser's "+ N" tail, or every label downstream
    # inherits shell text and the plain-phrase map below never gets a match. The tail is kept
    # aside, because it is the only sight of the program when the input carries no command.
    tail = raw_name.split(":", 1)[1].strip() if ":" in raw_name else ""
    # The runtime can put the work's own wording in the tool's NAME and hand over no arguments at
    # all ("read_file: README.md", "terminal: Checking disk space and ..."). The tail is then the
    # only material there is, and it is the model's own language: prose becomes the label as it was
    # written, and a bare filename, folder or host becomes the object of the tool's own verb. Prose
    # must never be read as a program — "Ran checking" is what that produces, and it says nothing.
    def _tail_sentence(t):
        """A prose tail as a label: no dangling conjunction, no trailing punctuation."""
        return re.sub(r"\s+(?:and|or|with|to|for|the|a|an)$", "", t.strip().rstrip(" .,:;-"))
    _tail_words = tail.split()
    _progs = ("sudo", "env", "bash", "sh", "python", "python3", "node", "npm", "git", "curl", "wget",
              "df", "du", "ls", "find", "grep", "rg", "cat", "head", "tail", "sed", "awk", "systemctl",
              "journalctl", "docker", "ssh", "mkdir", "cp", "mv", "rm", "chmod", "pip", "uptime", "date")
    tail_prose = (len(_tail_words) >= 2 and _tail_words[0][:1].isupper()
                  and _tail_words[0].lower() not in _progs)

    def tail_object():
        """A safe noun from the name's own tail: never a full path, never an argument."""
        t = tail.strip().strip("'\"")
        if not t:
            return ""
        if re.match(r"https?://", t, re.I):
            return "the page at " + (urllib.parse.urlparse(t).hostname or "the web")
        leaf = t.rstrip("/").split("/")[-1]
        is_file = "." in leaf
        # Same rule as kind(): the leaf is an identifier, so it keeps its spelling and its extension.
        leaf = leaf.strip()
        if leaf and re.match(r"^[\w .-]+$", leaf) and (is_file or "/" in t or low in
                                                       ("read file", "write file", "patch", "str replace")):
            return "the %s %s" % (leaf, "file" if is_file else "folder")
        return ""
    words = re.split(r"\s*:\s*", words, 1)[0].strip()
    words = re.sub(r"\s*\+\s*\d+\b.*$", "", words).strip()
    low = words.lower()
    if low == "terminal":
        # The tail can be a sentence rather than a command ("Checking disk space and ..."). That is
        # the best label there is, so it is the label; a real command's first word is a program and
        # never capitalised, so the two can be told apart without guessing.
        if tail_prose:
            return _tail_sentence(tail)
        # A chip carries a description in plain words, never the call's arguments. Dumping the
        # command put raw shell, absolute paths and a half-truncated here-doc on his screen; showing
        # a clean one still read as a label rather than a sentence. The command itself is not lost:
        # it is in the row's own detail, one tap away. What he reads is what the program was doing.
        # The input does not always carry it — a wrapper reports the work in the tool's own name —
        # so the name's tail stands in. Only the program is ever read, never the arguments.
        cmd = ""
        if isinstance(inp, dict):
            cmd = inp.get("command") or inp.get("cmd") or inp.get("script") or ""
        if not (isinstance(cmd, str) and cmd.strip()):
            cmd = tail
        if isinstance(cmd, str) and cmd.strip():
            parts = cmd.strip().split()
            def prog_of(tok):
                return re.sub(r"[^a-z0-9_.-].*$", "", tok.split("/")[-1].lower())
            prog = prog_of(parts[0]) if parts else ""
            if prog in ("sudo", "env", "time", "nice", "nohup", "bash", "sh") and len(parts) > 1:
                prog = prog_of(parts[1])          # the wrapper, not the work
            plain = {"curl": "Fetched a page", "wget": "Fetched a page",
                     "ls": "Listed a folder", "find": "Looked through the files",
                     "grep": "Searched the files", "rg": "Searched the files",
                     "date": "Checked the real time", "uptime": "Checked how long it has been up",
                     "git": "Checked the repository", "df": "Checked the disk",
                     "du": "Checked the folder sizes", "ps": "Checked the running processes",
                     "python": "Ran a script", "python3": "Ran a script", "node": "Ran a script",
                     "npm": "Ran a build step", "make": "Ran a build step",
                     "cat": "Read a file", "head": "Read a file", "tail": "Read a file",
                     "sed": "Edited some text", "awk": "Edited some text",
                     "pip": "Checked the packages", "brew": "Checked the packages",
                     "journalctl": "Read the service log", "systemctl": "Checked a service",
                     "docker": "Checked a container", "ssh": "Reached another machine",
                     "mkdir": "Made a folder", "cp": "Copied a file", "mv": "Moved a file",
                     "rm": "Tidied up some files", "chmod": "Changed some permissions",
                     }.get(prog)
            # Add only a harmless noun from the call.  It makes adjacent calls to the same program
            # distinct without ever displaying the command, a flag, or an absolute path.
            obj = ""
            for token in parts[1:]:
                if token.startswith("-") or re.search(r"[|;&`$<>{}]", token):
                    continue
                if re.match(r"https?://", token, re.I):
                    obj = "the page at " + (urllib.parse.urlparse(token).hostname or "the web")
                    break
                if "/" in token:
                    leaf = token.rstrip("/").split("/")[-1]
                    if leaf and re.match(r"^[\w.-]+$", leaf):
                        # A folder is an identifier too. "jarvis_live" is not "jarvis live", and the
                        # known-directory map is where a nice name for a known folder belongs.
                        obj = "the %s folder" % leaf
                        break
            positional = [p for p in parts[1:] if not p.startswith("-") and
                          not re.search(r"[|;&`$<>{}]", p)]
            if not obj and prog in ("ls", "du", "find") and positional:
                leaf = positional[-1].rstrip("/").split("/")[-1]
                if re.match(r"^[\w.-]+$", leaf):
                    obj = "the %s folder" % leaf
            if not obj and prog in ("grep", "rg") and positional:
                query = re.findall(r"[A-Za-z0-9]+", positional[0])[:5]
                if query:
                    obj = " ".join(query)
            if not obj and prog == "systemctl" and positional:
                service = positional[-1].rsplit(".", 1)[0]
                if re.match(r"^[\w@.-]+$", service):
                    obj = "the %s service" % re.sub(r"[_-]+", " ", service)
            if prog == "git" and positional:
                git_work = {"status": "Checked the repository status",
                            "log": "Read the repository history",
                            "diff": "Checked the repository changes"}.get(positional[0])
                if git_work:
                    plain = git_work
            if plain:
                direct = {"Fetched a page", "Listed a folder", "Read a file", "Checked a service"}
                if obj and plain in direct:
                    return plain.split(" ", 1)[0] + " " + obj
                if obj and plain in ("Looked through the files", "Searched the files"):
                    # "Searched the files for the static folder" reads as if the folder were the
                    # target. The work happened inside it, so say so.
                    return plain + " in " + obj
                return plain + (" for " + obj if obj else "")
            if prog:
                # A validation flag is semantic input but is never printed.  Other unknown tools
                # still name their own program, which is a word rather than command syntax.
                # Shell plumbing is not work he needs to read: a trace of "Ran cd" six times says
                # nothing about what the answer did. It is still recorded, by what it was.
                plumbing = {"cd": "Set up the shell", "pwd": "Set up the shell", "export": "Set up the shell",
                            "set": "Set up the shell", "source": "Set up the shell", "unset": "Set up the shell",
                            "alias": "Set up the shell", "true": "Set up the shell", "false": "Set up the shell",
                            ":": "Set up the shell", "echo": "Ran a shell step", "printf": "Ran a shell step",
                            "test": "Ran a shell step", "[": "Ran a shell step"}
                if prog in plumbing:
                    return plumbing[prog]
                return ("Checked with " if "-t" in parts[1:] else "Used ") + prog
            # Nothing readable arrived: the call is a shell step and says only that.
            return "Ran a command"
    if low == "execute code" and isinstance(inp, dict):
        code = inp.get("code") or inp.get("script") or ""
        if isinstance(code, str):
            if re.search(r"web_search|web_extract|http", code):
                return "Searched the web"
            if re.search(r"read_file|open\(|Path\(", code):
                return "Read a file with a script"
        return "Ran a quick script"
    named = _object_title(low, inp)
    if named:
        return named.rstrip(".!?;:")
    if low == "screen show" and isinstance(inp, dict):
        kind = str(inp.get("kind") or "").strip()
        lbl = clean_sentence(inp.get("label")) or ""
        # The label is the model's own name for the thing it drew, so the step says WHAT went up
        # instead of saying that something did. Only the kind is left when no label came with it.
        if lbl:
            return "Rendered " + (lbl[:58].rstrip(" .-") + "..." if len(lbl) > 58 else lbl)
        if kind:
            return "Rendered a %s on the screen" % kind
    # No arguments arrived, but the name's tail names the thing: compose the tool's own verb with
    # it, so a read of README.md reads as "Read the readme file" rather than "Read a file".
    if low in ("search files", "web search") and tail:
        _q = clean_sentence(re.sub(r"[*?]+", " ", tail))
        if _q:
            return "Searched for " + _q
    if tail_prose:
        return _tail_sentence(tail)
    _obj = tail_object()
    if _obj:
        _lead = {"read file": "Read", "write file": "Wrote", "patch": "Edited", "str replace": "Edited",
                 "web extract": "Read", "browser exec": "Opened"}.get(low)
        if _lead:
            return "%s %s" % (_lead, _obj)
        if low in ("search files", "web search"):
            return "Searched for " + _obj
    verb = {"terminal": "Used the terminal", "read file": "Read a file",
            "tool search": "Looked for a tool", "tool describe": "Looked up how a tool works",
            "execute code": "Ran a script", "delegate task": "Handed work to a helper",
            "write file": "Wrote a file", "patch": "Edited a file",
            "search files": "Searched the files", "web search": "Searched the web",
            "web extract": "Read a page", "screen show": "Rendered it on the screen",
            "screen clear": "Took the screen down",
            "text to speech": "Spoke it", "browser exec": "Opened the page in a browser",
            "vision analyze": "Looked at the image", "memory": "Checked what it remembers",
            "fact store": "Checked its own records", "skill view": "Read one of its own skills",
            "skill manage": "Updated one of its own skills", "session search": "Searched past conversations",
            "cronjob": "Set a scheduled job", "computer use": "Drove the desktop",
            "think": "Thought it through", "todo list": "Wrote out the plan",
            "process manage": "Checked a running job", "memory": "Checked what it remembers",
            }.get(low)
    if verb:
        return verb
    # A tool with no title and no verb still gets an action rather than machinery. Its own name is
    # built from a verb stem ("create_pull_request", "list_issues"), so that stem becomes the
    # sentence and the rest of the name becomes its object. This is not a list of tools: it is the
    # handful of stems every tool name is made of, so a tool nobody has seen before still reads as
    # an action. The arguments are never used here, because that is where a code blob turns up.
    stem = {"create": "Created", "add": "Added", "get": "Fetched", "fetch": "Fetched", "read": "Read",
            "list": "Listed", "search": "Searched for", "update": "Updated", "set": "Set",
            "delete": "Deleted", "remove": "Removed", "send": "Sent", "post": "Posted",
            "write": "Wrote", "run": "Ran", "open": "Opened", "merge": "Merged", "close": "Closed",
            "push": "Pushed", "check": "Checked", "describe": "Looked up", "view": "Read",
            "call": "Ran", "query": "Queried", "download": "Fetched", "upload": "Uploaded",
            "apply": "Applied", "start": "Started", "stop": "Stopped", "analyze": "Looked at",
            "extract": "Read", "generate": "Generated", "convert": "Converted", "translate": "Translated"}
    parts_name = [w for w in re.split(r"[^a-z0-9]+", low) if w and w not in ("mcp", "tool", "tools", "server")]
    for pos, w in enumerate(parts_name):
        if w in stem:
            obj = " ".join(parts_name[pos + 1:])
            return stem[w] + (" " + obj if obj else "")
    if parts_name:
        return "Ran " + " ".join(parts_name[:4])
    return "Ran a step"


def tool_detail(output):
    """A short human tail of a tool result: the first thing it actually said."""
    s = output if isinstance(output, str) else json.dumps(output)
    s = (s or "").strip()
    try:
        o = json.loads(s)
        if isinstance(o, dict) and isinstance(o.get("output"), str):
            s = o["output"].strip()
            if o.get("error"):
                s = (s + " " + str(o["error"])).strip()
    except Exception:
        pass
    return " ".join(s.split())[:110]


@OPENUI.agent_result
def hermes_answer(prompt, stop=None, on_event=None, mode="voice", reasoning="none", web=False,
                  memory=True, conv=None, web_off=False):
    shape = route_format(prompt)
    """Ask the real agent. Returns (status, text); status is ok, empty, stopped, timeout or failed.

    It used to return prose on every path, so "I could not reach the agent just now, sir." was
    spoken and committed to memory as JARVIS's own words. An error is a status now, and the caller
    decides what to say about it.

    Called directly rather than through the voice shim: the shim buffers the whole
    answer anyway, and in quiet mode `session_id:` lands on stderr, so its parser falls
    through and returns the runtime notice line along with the reply.

    Run as a child held open and polled rather than with a fixed timeout, because a turn the
    operator has walked away from must actually stop: left alone it kept working for over
    forty seconds after he hung up, and then recorded a conversation he never heard.
    """
    import subprocess
    # General rules only: the old wording was written around one example (news) and governed
    # every delegated request of any kind. See item 16.
    # The register follows the mode, for the same reason the fast layer's prompt does: a written
    # answer forbidden from using a list is worse to read than no structure at all.
    if mode == "text":
        opening = ("Answer the user's actual question and complete any authorised work using your "
                   "tools. Return the findings in readable prose, with sources and retrieval dates for "
                   "external figures. A separate text presenter composes the final inline interface. "
                   "Do not author UI JSON, HTML, screen_show calls, or promises about controls. "
                   "For photographs identify exact subjects; the presenter can find credited images. "
                   "Put the completed findings between <<<SPOKEN and SPOKEN>>>.\n\n")
    else:
        opening = ("You are answering Mohammad through a voice interface that writes every word on "
                   "the screen as well as saying it, so the answer has to be sayable and scannable "
                   "at once. Give the result first, in plain English, and keep it as short as the "
                   "answer allows, usually one to three sentences; go longer only if he asked for "
                   "detail. No file paths, no code, no tool output, no status lines. Never deliver "
                   "it as one block of text: each subject gets its own short block, at most two "
                   "sentences to a block, and a longer or multi-topic answer puts a short '### ' "
                   "heading naming the subject on its own line above each block, so it reads like a "
                   "briefing rather than a paragraph. Items, figures and news lines go on their own "
                   "'- ' lines instead of being folded into a sentence. A heading may carry one "
                   "emoji; nothing else does. "
                   + format_directive(shape, "voice") + " " + NO_FILLER + " " + NO_VOICE_LOSS + " "
                   "If you cannot do it or are not sure, say so plainly rather than guessing, and "
                   "never state a figure you did not just verify. Put the spoken reply between "
                   "<<<SPOKEN and SPOKEN>>> and nothing else between them.\n\n")
    ask = (opening +
           "A file reaches him through this page, and the page has a door for it: write the file "
           "into /data/apps/jarvis-live/outbox/ under the name he should see, then put "
           "[[file:name]] on its own line in the reply, once per file. Each marker becomes a chip "
           "he taps to open or save it. A path on its own is not a handover, so a file he asked "
           "for is never answered with the place it sits. When he asks for a PDF, a document or a "
           "spreadsheet, build it, put it in the outbox and mark it. Never write a media, voice or "
           "audio directive: [[file:name]] is the one marker this page understands. A file HE "
           "attaches reaches you as a path named in his message: read it, and let what it holds "
           "reach him by being read out, put on the screen, or handed back as a file. "
           "He can open a working summary that lists each step of the job as you go, and it is the "
           "only account he has of what you did. Before your very first action, and before every "
           "action after it, write one short plain-language line naming what you are about to do "
           "and what you are working out, under about sixty characters, with no file paths and no "
           "command syntax. This covers the scripts and shell commands you run for yourself: those "
           "are the first steps of most jobs, and they are exactly the ones that end up listed as a "
           "bare machine action. A step listed that way tells him nothing, and eight of them in a "
           "row tell him less, so write the line in his words, not the tool's. "
           + ("For this written turn, the common presenter chooses inline UI from your findings. "
              "Do not publish through screen_show or build a separate reply widget. "
              "A downloadable file is still handed over with "
              "its file marker when requested.\n\n" if mode == "text" else
           "He also has a screen in front of him, and screen_show puts a thing on it. Showing is "
           "separate from speaking, so whenever the answer is a thing rather than a sentence - a "
           "table, a set of numbers, a list, a file's contents, a picture - show it with "
           "screen_show and keep the spoken part to one short line about it. When he asks to see "
           "something without naming it, choose one real thing he would want and show that, "
           "asking him which. When he says continue, next or go on, carry on with the thing you "
           "were already doing in the same order, and never switch to a different subject. After "
           "a panel is pushed, say nothing about the panel itself: never describe it as still "
           "coming, never say you cannot show something you have just shown, and never spend a "
           "sentence saying what is now on the screen, because he is looking at it. What you say "
           "next has to be something the panel does not already carry. If screen_show answers that no screen is open, say plainly that the screen is "
           "not connected and answer out loud instead.\n\n"
           "One more thing about the screen. When the answer is a set of recommendations, a "
           "comparison or a set of options, a paragraph is the wrong shape: build a reply panel "
           "and put it on the screen. Write the reply as JSON in the shape tools/reply_widget.py "
           "documents (a title, an intro, cards that may carry an image, a badge and links, then "
           "up to two groups of choices), run its check command on that file with a short label, "
           "and only if it passes push it with screen_show kind=widget and the url the push "
           "printed. A single table, list or set of numbers is still its own artifact kind; the "
           "widget is for a composition that has to respond to a tap. A control that does "
           "nothing is a lie, so never draw one. Write nothing about it afterwards: the widget is "
           "the answer, and a sentence pointing at it is the filler he asked you to stop writing.\n\n")
           + (WEB_NOTE if web else "") + ("" if memory else NO_MEMORY_NOTE) + thread_note(conv) + prompt)
    if mode == "text":
        ask = (opening + "Only perform the work actually authorised in the request. An inline answer, "
               "photograph, recommendation, comparison or plan is not a request to create a file. "
               "Do not build PDFs, scripts or screen artifacts unless the user explicitly requested that "
               "deliverable. The text presenter handles all inline layout and pictures. If essential "
               "details are missing, ask for them. When a downloadable file was explicitly requested, "
               "use the existing outbox and [[file:name]] handover. "
               + (WEB_NOTE if web else "") + ("" if memory else NO_MEMORY_NOTE) + thread_note(conv) + prompt)
    _guard_path("enter", conv, "hermes_answer")
    model = config_model()
    # Text can reuse ACP only after the complete cold-path prompt and gate context are prepared.
    mark_agent_seen(conv)
    argv = [HERMES_BIN, "chat", "-q", ask, "--oneshot", "-Q", "--reasoning", reasoning,
            "-c", agent_session_name(conv), "--run-budget", str(int(AGENT_RUN_BUDGET)),
            "--create-if-missing", "--format", "stream-json"]
    if model:
        # Explicit, so a resumed session can never restore a model this config does not name.
        argv += ["-m", model]
    # A staging copy must not write the live agent's state. JARVIS_LIVE_AGENT_HOME is set only on a
    # staging unit; unset (as it is on live) the child inherits the environment exactly as before.
    # Only what the engine needs. The child no longer inherits this process's environment, so a
    # variable that arrives in the parent cannot ride into a turn, and a secret in the service
    # environment has nowhere to go. HERMES_HOME is added only when a staging unit asks for it.
    _ALLOW = ("PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "USER", "LOGNAME",
              "PYTHONUNBUFFERED", "PYTHONPATH", "TERM", "XDG_RUNTIME_DIR", "XDG_DATA_DIRS",
              "SSL_CERT_FILE", "VIRTUAL_ENV", "DBUS_SESSION_BUS_ADDRESS")
    _env = {k: os.environ[k] for k in _ALLOW if k in os.environ}
    _response = globals().get('RESPONSE_AUTHORING')
    if _response:
        _env['JARVIS_SCREEN_PUBLICATION'] = json.dumps(_response.SOURCES.publisher_context())
    _agent_home = os.environ.get("JARVIS_LIVE_AGENT_HOME")
    if _agent_home:
        _env["HERMES_HOME"] = _agent_home
    # A web turn is the only kind with a person watching it, so it is the only kind the guard
    # covers. JARVIS_WEB_GUARD on the service decides the mode; unset means no change at all.
    if True:                                    # every spawn from here serves a web route
        _env["JARVIS_WEB_TURN"] = "1"
        _env["JARVIS_WEB_CHAT"] = str(conv or "")
        _env["JARVIS_WEB_MODES"] = os.path.join(HERE, "modes.json")
        _env["JARVIS_WEB_GUARD"] = os.environ.get("JARVIS_WEB_GUARD") or "deny"
        _env["JARVIS_GUARD_LOG"] = os.path.join(HERE, "logs", "web_guard.log")
        _sec = secrets.token_hex(16)
        with approval_lock():
            APPROVAL_SECRETS[(str(conv or ""), "")] = _sec
        _env["JARVIS_APPROVAL_SECRET"] = _sec
        _env["JARVIS_APPROVAL_URL"] = "http://127.0.0.1:%d/agent/ask" % PORT
        _env["JARVIS_WEB_CTX"] = write_turn_ctx(str(conv or ""), _env["JARVIS_WEB_MODES"],
                                                _env["JARVIS_WEB_GUARD"], _env["JARVIS_GUARD_LOG"],
                                                _sec, _env["JARVIS_APPROVAL_URL"],
                                                "auto" if AUTO_ENABLED else "ask")
    # Per-chat switches, enforced where the toolset and the memory loader actually live: the child
    # starts without the web tools, without the memory tool, and without MEMORY.md/USER.md loaded.
    _disable = []
    if web_off:
        _disable.append("web")
    if not memory:
        _disable.append("memory")
        _env["HERMES_TURN_SKIP_MEMORY"] = "1"
    if _disable:
        _env["HERMES_TURN_DISABLE_TOOLSETS"] = ",".join(_disable)
    if mode == "text" and not web and memory and not web_off and _env.get("JARVIS_WEB_CTX"):
        warmed = warm_answer(ask, stop, on_event, reasoning=reasoning, screen=True, conv=conv)
        print("warm turn: used=%s name=%s" % (warmed is not None, agent_session_name(conv)), flush=True)
        if warmed is not None:
            _guard_path("warm", conv, "prepared text turn")
            return warmed
    _guard_path("cold", conv, "web turn")
    try:
        proc = subprocess.Popen(argv,
                                cwd=WORKDIR, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, start_new_session=True, env=_env)
    except Exception as e:
        print("ERROR agent spawn failed" if mode == "text" else "could not start the agent: %r" % (e,), flush=True)
        return ("failed", "The agent could not be started, so this turn did not run. "
                          "Nothing was executed.")

    def kill():
        # Its own session, so the whole tree goes: the hermes entry point is a launcher over a
        # worker, and killing only the launcher left the worker running on its own.
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        try:
            proc.communicate(timeout=10)
        except Exception:
            pass

    # stream-json: the run reports itself line by line, so the screen can show the real work
    # while it happens and the answer is read from the final `result` event rather than being
    # waited for as one blob. A pump thread drains stdout: a child that writes more than the
    # pipe buffer (about 64 KB) blocks on the write and never exits, which is the deadlock the
    # old communicate() loop existed to avoid.
    errbox = []
    threading.Thread(target=lambda: errbox.append(proc.stderr.read() or ""), daemon=True).start()
    stream_q = queue.Queue()

    def pump():
        try:
            for line in proc.stdout:
                stream_q.put(line)
        except Exception:
            pass
        stream_q.put(None)

    threading.Thread(target=pump, daemon=True).start()
    deadline = time.time() + AGENT_TIMEOUT
    joined, final_text, last_tool = [], "", ""
    provider_failed = False
    narr = []                      # the agent's own running commentary, gathered into lines
    reply_open = [False]           # inside the <<<SPOKEN reply markers

    def flush_narration():
        """Hand over what the agent said since the last action, as a single line."""
        if not on_event or not narr:
            return
        line = " ".join(strip_delivery("".join(narr)).split())
        # Markdown marks are punctuation the agent wrote for another reader, not part of the line.
        line = re.sub(r"^[#*\->\s]+", "", line).strip()
        narr.clear()
        if 3 < len(line) <= 110:
            on_event("note", "", line)
    while True:
        try:
            line = stream_q.get(timeout=0.25)
        except queue.Empty:
            if stop and stop():
                kill()
                print("stopped the agent: the operator is no longer listening")
                return ("stopped", "")
            if time.time() > deadline:
                kill()
                # The agent's own budget should have ended the run before this backstop, and if we
                # are here it hung. Even then, whatever it wrote is worth saying: a turn that built
                # the thing and ran out of road one sentence short of describing it is not an empty
                # answer, and discarding those words is what the page then reports as nothing.
                partial = spoken_from_output(
                    final_text if final_text.strip() else "".join(joined))[0]
                if mode == "text":
                    print("ERROR agent cold turn timed out; partial output is not a successful answer", flush=True)
                    return ("timeout", "")
                if partial.strip():
                    print("agent hit the backstop with words in hand: keeping them")
                    return ("ok", partial)
                return ("timeout", "")
            continue
        if line is None:
            break
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except Exception:
            joined.append(line)          # not an event: keep it for the sentinel parser
            continue
        if not isinstance(ev, dict):
            continue
        what = ev.get("type")
        if what == "tool_use":
            flush_narration()          # what it just said describes what it is about to do
            last_tool = str(ev.get("name") or "tool")
            inp = ev.get("input") or {}
            if on_event:
                on_event("run", last_tool, tool_line(last_tool, inp), None,
                         title=tool_title(last_tool, inp))
        elif what == "tool_result":
            who = str(ev.get("name") or last_tool or "tool")
            ok = not ev.get("is_error")
            if on_event:
                on_event("ok" if ok else "err", who, tool_detail(ev.get("output")),
                         ev.get("duration_ms"))
        elif what == "error" and mode == "text":
            provider_failed = True
        elif what == "result":
            if mode == "text" and (ev.get("is_error") or ev.get("error") or ev.get("status") in ("failed", "error")):
                provider_failed = True
            final_text = str(ev.get("text") or "")
        elif what == "text":
            piece = str(ev.get("text") or "")
            joined.append(piece)
            # The agent's own running commentary, said as it works. The reply is what it puts
            # between the <<<SPOKEN sentinels it was told to use, so anything written OUTSIDE those
            # is narration, and narration is what the summary was missing: it is where "Diagnosing
            # the layout" comes from, as opposed to a list of machine actions. The stream arrives in
            # fragments, so they are gathered into a line before it is handed over.
            if on_event and piece:
                # The reply sits between <<<SPOKEN and SPOKEN>>>, and the markers arrive split across
                # fragments, so the state is read from the whole text rather than matched on each
                # fragment. Once the reply has begun everything after it is the answer, and an answer
                # filed as narration is worse than no narration at all.
                _all = "".join(joined)
                _open_at = _all.rfind("<<<SPOKEN")
                _closed = _all.rfind("SPOKEN>>>") > _open_at >= 0
                if _open_at != -1:
                    narr.clear()
                    # The reply itself, handed over while it is still being written. Until now the
                    # page heard nothing between "thinking" and the finished answer, so a report
                    # that took a minute and a half looked like a turn that had died. Fragments
                    # before the opening marker are dropped; the closing marker is trimmed off.
                    if not _closed:
                        _frag = piece.split("<<<SPOKEN", 1)[1] if "<<<SPOKEN" in piece else piece
                        if _frag and on_event:
                            on_event("live", "", _frag)
                else:
                    narr.append(piece)
                    buffered = "".join(narr)
                    if not re.search(r"<{1,3}$", buffered):      # a marker still forming, wait
                        if re.search(r"[.!?:]\s*$", buffered) or "\n" in buffered or len(buffered) >= 90:
                            flush_narration()
    flush_narration()          # nothing left unsaid when the work stops
    try:
        proc.wait(timeout=10)
    except Exception:
        pass
    err = errbox[0] if errbox else ""
    if mode == "text" and proc.returncode is not None:
        for pipe in (proc.stdout, proc.stderr):
            try:
                pipe.close()
            except Exception:
                pass
    if err:
        # Last 2 KB, for the journal only. Never spoken.
        print("agent stderr: %s" % err[-2000:].replace("\n", " ")[:2000])
    if mode == "text" and (provider_failed or proc.returncode != 0):
        print("ERROR agent cold turn failed: provider_error=%s exit=%s" % (provider_failed, proc.returncode), flush=True)
        return ("failed", "")
    if proc.returncode != 0:
        return ("failed", "")
    spoken, via_sentinels = spoken_from_output(
        final_text if final_text.strip() else "".join(joined), screen=(mode == "text"))
    if not via_sentinels:
        # The agent ignored the sentinel instruction: still repaired, but counted, so the rate is
        # visible instead of guessed.
        FALLBACK_COUNT[0] += 1
        print("agent did not use the sentinels (%d times so far)" % FALLBACK_COUNT[0])
    if not spoken.strip():
        return ("empty", "")
    return ("ok", spoken)


def _tee(text_iter, sink):
    """Pass a stream through while collecting it."""
    for chunk in text_iter:
        sink.append(chunk)
        yield chunk


class Speaker:
    """Speak units through a small pool, emitting them strictly in order.

    One unit at a time the speech service produces 0.98x real time: measured over a whole turn,
    18.4 seconds of audio in 18.8 seconds of wall time. The page's buffer therefore drains a
    little at every unit boundary and the reply stutters. Three units at once measured 2.72x
    with no loss of per-request latency, the first byte still arriving in about a second. So
    synthesis runs ahead here while emission stays in order: a part reaches the page only once
    every earlier unit has been written in full.

    Each part carries its unit number and a part index; a part of -1 closes the unit.
    """
    def __init__(self, out, counter, depth=3):
        self.out = out
        self.counter = counter
        self.depth = depth
        self.cancelled = threading.Event()
        self.lock = threading.Condition()
        self.pending = {}          # idx -> {"parts": [...], "part": n, "n": unit number, ...}
        self.submitted = 0
        self.emitted = 0
        self.stopped = False
        self.worker = threading.Thread(target=self._emit, daemon=True)
        self.worker.start()

    def submit(self, text, kind="front"):
        if not text or not text.strip():
            return
        with self.lock:
            # Bound the lead: wait for the speaker to catch up rather than synthesising a whole
            # answer into memory.
            while self.submitted - self.emitted >= self.depth and not self.stopped:
                self.lock.wait(timeout=0.5)
            if self.stopped:
                return
            idx = self.submitted
            self.submitted += 1
            self.pending[idx] = {"parts": [], "part": 0, "done": False, "err": "",
                                 "kind": kind, "n": 0, "started": False, "text": text}
        threading.Thread(target=self._synth, args=(idx, text), daemon=True).start()

    def _synth(self, idx, text):
        err = ""
        try:
            for chunk in fish_stream(text):
                if self.cancelled.is_set():
                    print("stopped asking for speech: the turn was abandoned")
                    break
                with self.lock:
                    if idx in self.pending:
                        self.pending[idx]["parts"].append(chunk)
                    self.lock.notify_all()
        except Exception as e:
            err = str(e)[:100]
        with self.lock:
            if idx in self.pending:
                self.pending[idx]["err"] = err
                self.pending[idx]["done"] = True
            self.lock.notify_all()

    def _emit(self):
        while True:
            with self.lock:
                u = self.pending.get(self.emitted)
                if u is None:
                    if self.stopped and not self.pending:
                        return
                    self.lock.wait(timeout=0.25)
                    continue
                if not u["started"]:
                    u["started"] = True
                    self.counter[0] += 1
                    u["n"] = self.counter[0]
                while u["parts"]:
                    chunk = u["parts"].pop(0)
                    self.out.put(("audio", {"n": u["n"], "kind": u["kind"], "part": u["part"],
                                            "d": u["text"] if u["part"] == 0 else "",
                                            "mp3": base64.b64encode(chunk).decode()}))
                    u["part"] += 1
                if u["done"]:
                    if u["err"]:
                        self.out.put(("warnerr", {"err": u["err"]}))
                        if u["text"]:
                            self.out.put(("tok", {"d": u["text"], "kind": "speak",
                                                  "n": u["n"]}))
                    self.out.put(("audio", {"n": u["n"], "kind": u["kind"], "part": -1}))
                    del self.pending[self.emitted]
                    self.emitted += 1
                    self.lock.notify_all()
                    continue
                self.lock.wait(timeout=0.25)

    def abort(self):
        """He hung up: stop asking the speech service for audio nobody will hear."""
        self.cancelled.set()
        with self.lock:
            self.stopped = True
            self.pending.clear()
            self.lock.notify_all()

    def close(self, timeout=45.0):
        with self.lock:
            self.stopped = True
            self.lock.notify_all()
        self.worker.join(timeout=timeout)



# The stored conversation used to be read HERE, over a thousand lines above the definitions its own
# idle check reaches: closing an expired window calls close_session → archive_session, and
# archive_session is defined near the bottom of this file. Nothing went wrong until a stored
# conversation was genuinely old enough to expire at boot, and then the page came back from a restart
# into a crash loop: NameError at import, every retry. The load waits for the definitions now, at the
# foot of the module, which is also the right order for the archive itself — the session store has to
# be read before a closing window can be merged into it.


# Base at five beams is the everyday pass; the larger model is a recovery pass only. Measured
# across 25 of his own clips: base 0.92s average, the larger model 2.49s, and the larger one
# changed the transcript on 12 clips while losing as often as it won, once inventing a phrase
# outright. It is therefore never the default: see transcribe().
WHISPER = {"models": {}, "lock": threading.Lock(), "name": os.environ.get("JARVIS_STT_MODEL", "base"),
           "fallback": os.environ.get("JARVIS_STT_FALLBACK", "small")}
# The prime is a vocabulary list, not a sample sentence. Whisper can hand its own priming text
# back on weak audio, and a prompt that reads like a command is a phrase it can return. Kept in a
# file so a new name can be added without touching code; reloaded when the file changes.
VOCAB_FILE = os.path.join(HERE, "stt_vocab.txt")
VOCAB_BUILTIN = "JARVIS, InspectFirst, Mohammad, Kampala, Nahia, Arsenal, Bolt, Faras, Uber"
VOCAB_CACHE = {"at": None, "prompt": "", "words": set()}


def vocab():
    terms = []
    try:
        with open(VOCAB_FILE, encoding="utf-8") as f:
            terms = [t.strip() for t in f.read().replace("\n", ",").split(",") if t.strip()]
        stamp = os.path.getmtime(VOCAB_FILE)
    except Exception:
        stamp = None
    if not terms:
        terms = [t.strip() for t in VOCAB_BUILTIN.split(",") if t.strip()]
    if VOCAB_CACHE["at"] != stamp or not VOCAB_CACHE["prompt"]:
        VOCAB_CACHE["prompt"] = ", ".join(terms)
        VOCAB_CACHE["words"] = {w.lower().strip(".,!?") for t in terms for w in t.split()}
        VOCAB_CACHE["at"] = stamp
    return VOCAB_CACHE["prompt"], VOCAB_CACHE["words"]


def whisper(name=None):
    """Load once, keep warm. Speech to text runs here rather than in the browser: the
    browser's recogniser depends on a service I cannot see, which is why the microphone
    kept failing silently. Measured on this box, the small model handles a 1.5 second clip
    in 0.9s and the larger one in 1.5s, both correctly, so the small one runs first."""
    name = name or WHISPER["name"]
    if name not in WHISPER["models"]:
        with WHISPER["lock"]:
            if name not in WHISPER["models"]:
                from faster_whisper import WhisperModel
                WHISPER["models"][name] = WhisperModel(
                    name, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4,
                    download_root=os.path.join(HERE, "models"))
    return WHISPER["models"][name]


HALLUCINATIONS = {"thank you.", "thanks for watching.", "thank you for watching.",
                  "please subscribe.", "subscribe.", "you", ".", "okay.", "ok.", "bye.",
                  "yeah.", "hmm.", "uh.", "the patient.", "payment.", "hello, dear."}


def read_wav_samples(path):
    """Read a WAV we are willing to trust: 16-bit mono PCM, sane rate, bounded length.
    Anything else raises, and the caller treats it as no speech rather than guessing."""
    import wave as _wave
    with _wave.open(path, "rb") as w:
        rate = w.getframerate()
        channels = w.getnchannels()
        width = w.getsampwidth()
        frames = w.getnframes()
        if rate <= 0 or rate > 48000:
            raise ValueError("invalid sample rate")
        if channels not in (1, 2):
            raise ValueError("audio must be mono or stereo")
        if width != 2:
            raise ValueError("audio must be 16-bit PCM")
        if frames <= 0:
            raise ValueError("empty audio")
        if frames / float(rate) > MAX_STT_SECONDS:
            raise ValueError("audio longer than the limit")
        raw = w.readframes(frames)
    expected = frames * channels * 2
    if len(raw) != expected:
        raise ValueError("truncated WAV")
    # Vectorised rather than a Python loop over every sample. int32 throughout so
    # abs(-32768) cannot wrap to itself, which int16 would.
    arr = np.frombuffer(raw, dtype="<i2").astype(np.int32)
    if channels == 2:                      # fold to mono: the transcriber wants one channel
        arr = (arr[0::2] + arr[1::2]) // 2
    return rate, arr


def clean_and_boost(path):
    """Phone audio arrives quietly and padded with silence. Trim the padding and lift the
    level, which is the difference between 'Thank you.' and the actual words."""
    import wave as _wave
    try:
        rate, samples = read_wav_samples(path)
    except Exception:
        return path, 0.0
    if samples.size == 0:
        return path, 0.0
    win = max(rate // 50, 1)
    # The same windows as before, including the same short final one: pad to a whole number of
    # windows, take the peak of each. The pad is zeros, so it can never raise a peak.
    width = (samples.size + win - 1) // win
    padded = np.zeros(width * win, dtype=np.int32)
    padded[:samples.size] = np.abs(samples)
    blocks = padded.reshape(width, win).max(axis=1)
    peak_all = int(blocks.max())
    if peak_all == 0:
        return path, 0.0
    gate = peak_all * 0.06
    loud = np.flatnonzero(blocks > gate)
    if loud.size == 0:
        return path, 0.0
    start = max(0, (int(loud[0]) - 3) * win)
    end = min(samples.size, (int(loud[-1]) + 4) * win)
    speech = (int(loud[-1]) - int(loud[0]) + 1) * win / float(rate)
    kept = samples[start:end]
    peak = int(np.abs(kept).max()) if kept.size else 0
    if peak:
        gain = min((0.85 * 32767.0) / peak, 40.0)
        # clip then truncate towards zero, which is what the Python int() did
        kept = np.clip(kept.astype(np.float64) * gain, -32768, 32767)
    with _wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(kept.astype("<i2").tobytes())
    return path, speech


# Whisper does not hear the name at any size: base returns "Javis"/"Javi" and the larger model
# "Javi", with the name already at the front of the prompt. A deterministic fixup costs nothing
# and cannot invent anything.
NAME_FIX = re.compile(r"\b(?:jarvis|javis|jarvi|jarvus|jarviss|javi)\b", re.I)


def fix_names(text):
    if not text:
        return text
    text = NAME_FIX.sub("JARVIS", text)
    return re.sub(r"\bInspect\s+First\b", "InspectFirst", text, flags=re.I)


def transcribe(wav):
    """The everyday pass at full depth, then a recovery pass that cannot make things worse.

    Depth is not a luxury. At five beams the same model costs about a tenth of a second and
    fixed three of the errors that changed what he had asked: "Testing. Fue." -> "Testing
    fuel.", "That is word the news." -> "That is all the news.", and "A lot of read me the
    news." -> "Hello. Read me the news."

    The larger model is not a general upgrade, so it is used only where there is nothing to
    lose: he spoke for over a second and the fast pass came back with almost nothing. A
    confidence threshold cannot do this job, because correct and incorrect transcripts share
    the same range (-0.05 to -0.53 measured).
    """
    def run(name, beam):
        segs, info = whisper(name).transcribe(
            wav, language="en", beam_size=beam, vad_filter=True,
            condition_on_previous_text=False, temperature=0.0, no_speech_threshold=0.65,
            initial_prompt=vocab()[0])
        segs = list(segs)
        text = " ".join(s.text.strip() for s in segs).strip()
        conf = sum(getattr(s, "avg_logprob", -9.0) for s in segs) / len(segs) if segs else -9.0
        return text, conf, info

    text, conf, info = run(WHISPER["name"], 5)
    used = WHISPER["name"]
    # Empty only, and only after a real stretch of speech. Widening this to "thin" results
    # made him wait four seconds for "Hello.", which base had already heard perfectly.
    thin = not text.strip()
    if thin and info.duration > 2.0 and WHISPER["name"] != WHISPER["fallback"]:
        if not model_present(WHISPER["fallback"]):
            # A model that is not here would download inside the request (a hang) or raise
            # (a 500 where the honest answer is an empty transcript).
            print("recovery pass skipped: the %s model is not on disk" % WHISPER["fallback"])
        else:
            try:
                second, conf2, info2 = run(WHISPER["fallback"], 1)
            except Exception as e:
                print("recovery pass failed: %s" % str(e)[:120])
            else:
                if second.strip() and second.strip().lower() not in HALLUCINATIONS:
                    print("recovery pass: %r -> %r" % (text[:40], second[:40]))
                    text, conf, info, used = second, conf2, info2, WHISPER["fallback"]
    if looks_like_the_prompt(text, info.duration):
        print("stt: discarded the priming text handed back as speech (%r)" % text[:60])
        text = ""
    return fix_names(text), info, used


def model_present(name):
    """Whether the weights are already on disk, so no download can happen inside a request."""
    if not name:
        return False
    if os.path.isdir(name):
        return True
    for root in (os.path.join(HERE, "models"), os.path.expanduser("~/.cache/huggingface/hub")):
        if not os.path.isdir(root):
            continue
        for d in os.listdir(root):
            if name in d and glob.glob(os.path.join(root, d, "snapshots", "*", "model.bin")):
                return True
    return False


def looks_like_the_prompt(text, speech_s):
    """Whether a transcript is the priming vocabulary read back rather than speech.

    Every word in the vocabulary, on a clip too short to have carried a sentence: that is an
    invention. Deliberately a per-word test and not a substring test against the prompt: the
    prompt is natural language, so substring overlap would delete a legitimate request.
    """
    words = [re.sub(r"[^\w']", "", w).lower() for w in (text or "").split()]
    words = [w for w in words if w]
    if not words or speech_s >= 1.2:
        return False
    return all(w in vocab()[1] for w in words)


def warm_whisper():
    try:
        whisper()
        print("whisper ready:", WHISPER["name"])
    except Exception as e:
        print("whisper unavailable:", str(e)[:160])


@app.post("/stt")
async def stt(request: Request):
    """Speech to text. The phone sends 16 kHz mono WAV, built in the browser, so there is no
    conversion step and no container format to go wrong."""
    if not authed(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    if not same_origin(request):
        return JSONResponse({"error": "cross-site"}, status_code=403)
    if not rate_ok(request, "stt"):
        return JSONResponse({"text": "", "reason": "too many uploads from this device",
                             "type": "stt_busy"}, status_code=429)
    import json as _json
    import subprocess
    import tempfile
    import time as _time
    import wave

    t_recv = _time.time()

    # refuse anything oversized before it is read into memory
    clen = request.headers.get("content-length")
    if clen is not None:
        try:
            if int(clen) > MAX_STT_BYTES:
                return JSONResponse({"text": "", "reason": "audio too large",
                                     "type": "stt_invalid"}, status_code=413)
        except ValueError:
            return JSONResponse({"text": "", "reason": "invalid content length",
                                 "type": "stt_invalid"}, status_code=400)

    raw = await request.body()
    if len(raw) > MAX_STT_BYTES:
        return JSONResponse({"text": "", "reason": "audio too large",
                             "type": "stt_invalid"}, status_code=413)
    if len(raw) < 2000:
        return JSONResponse({"text": "", "reason": "clip too short", "type": "stt_empty",
                             "bytes": len(raw)})

    # Only two at a time: the machine has four cores and transcription is the expensive part.
    # A stale upload used to make the next utterance fail outright; now it waits briefly for a
    # slot. acquire() blocks, so it must not run on the event loop.
    got = await asyncio.to_thread(STT_SEMAPHORE.acquire, True, 3.0)
    if not got:
        return JSONResponse({"text": "", "reason": "transcriber busy",
                             "type": "stt_busy"}, status_code=429)

    src = None
    wav = None
    try:
        ctype = (request.headers.get("content-type") or "").lower()
        suffix = ".wav" if "wav" in ctype else ".webm"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(raw)
            src = f.name
        wav = src if suffix == ".wav" else src + ".wav"
        converted = False
        duration = 0.0
        try:
            with wave.open(wav, "rb") as w:
                duration = w.getnframes() / float(w.getframerate() or 1)
                rate, channels = w.getframerate(), w.getnchannels()
        except Exception:
            rate, channels = 0, 0
        if suffix != ".wav" or rate == 0:
            await asyncio.to_thread(
                subprocess.run, ["ffmpeg", "-v", "error", "-y", "-i", src, "-ac", "1",
                                 "-ar", "16000", wav], capture_output=True, timeout=60)
            converted = True

        t_trans = _time.time()
        wav, speech_s = await asyncio.to_thread(clean_and_boost, wav)
        if speech_s < 0.30:                      # almost no speech: anything the model says is invention
            result = {"text": "", "reason": "no speech in the clip",
                      "seconds": round(speech_s, 2), "received_s": round(t_trans - t_recv, 2),
                      "transcribe_s": 0.0, "model": "skipped", "bytes": len(raw)}
            keep_for_diagnosis(wav, result)
            print("stt: no speech (%.2fs of sound) - ignored" % speech_s)
            return JSONResponse(result)
        text, info, used_model = await asyncio.to_thread(transcribe, wav)
        if text.strip().lower() in HALLUCINATIONS and speech_s < 0.9:
            print("stt: discarded an invention (%r) from %.2fs of sound" % (text, speech_s))
            text = ""
        t_done = _time.time()

        result = {
            "text": text,
            "seconds": round(info.duration, 2),
            "speech_s": round(speech_s, 2),
            "received_s": round(t_trans - t_recv, 2),
            "transcribe_s": round(t_done - t_trans, 2),
            "model": used_model,
            "rate": rate,
            "channels": channels,
            "converted": converted,
            "bytes": len(raw),
        }
        await asyncio.to_thread(keep_for_diagnosis, src if suffix != ".wav" else wav, result)
        print("stt[%s]: %r | %.2fs speech (%.2fs clip) | %.2fs transcribed (%s)" % (
            request.headers.get("X-Jarvis-Page", "unknown-page"), text[:80],
            result.get("speech_s", -1), result["seconds"], result["transcribe_s"], result["model"]))
        return JSONResponse(result)
    except Exception as e:
        print("stt failed:", str(e)[:200])
        return JSONResponse({"error": str(e)[:200], "text": "",
                             "type": "model_failed"}, status_code=500)
    finally:
        STT_SEMAPHORE.release()
        for f in (src, wav):
            if not f:
                continue
            try:
                os.unlink(f)
            except Exception:
                pass


def keep_for_diagnosis(path, result):
    """Keep the last few clips with what we made of them. When a transcript comes out wrong,
    the clip itself is the only way to tell whether the recording or the model was at fault."""
    import json as _json
    import shutil as _shutil
    import time as _time
    try:
        d = os.path.join(HERE, "clips")
        os.makedirs(d, exist_ok=True)
        stamp = _time.strftime("%Y%m%d-%H%M%S")
        _shutil.copyfile(path, os.path.join(d, stamp + ".wav"))
        with open(os.path.join(d, stamp + ".json"), "w") as f:
            _json.dump(result, f)
        files = sorted(glob.glob(os.path.join(d, "*.wav")))
        for old in files[:-25]:
            for ext in (".wav", ".json"):
                try:
                    os.unlink(old.replace(".wav", ext))
                except Exception:
                    pass
    except Exception as e:
        print("could not keep the clip:", str(e)[:120])


def _cancel_conv(conv: str) -> bool:
    """Stop whichever turn is working in one conversation, by its own name."""
    with LIVE_LOCK, TURN_CHANS_LOCK:
        for num, chan in list(TURN_CHANS.items()):
            if str(getattr(chan, "conv", "") or "") == str(conv or "") and not getattr(chan, "done", False):
                victim = LIVE_TURNS.get(num)
                if victim is not None:
                    victim["yes"] = True
                invalidate_conv(conv)
                print("cancel by conversation: stopping turn %s" % num)
                return True
    return False


def _seen_path(conv: str) -> str:
    return os.path.join(HERE, "ctx", "seen-" + re.sub(r"[^0-9a-zA-Z_-]", "", str(conv or ""))[:64] + ".json")


def thread_note(conv: str) -> str:
    """What was already said in this chat, for the agent's first turn in it.

    The fast layer answers from the page's own window and never writes into the agent's session, so a
    follow-up handed to the agent began with a blank mind: he asked "use a graph" after a table of
    figures and was asked which figures. The page's last exchanges travel with the first agent turn
    of a conversation, and only that first one, so a long chat does not re-send its history on every
    turn.
    """
    if not conv:
        return ""
    # How much of this chat the agent has already been given. A mark of 0 means it has seen none.
    mark_at = 0.0
    try:
        with open(_seen_path(conv), encoding="utf-8") as f:
            mark_at = float(json.load(f).get("at") or 0)
    except Exception:
        mark_at = 0.0
    try:
        hist = [m for m in recall(conv)
                if m.get("content") and float(m.get("at") or 0) > mark_at][-8:]
    except Exception:
        hist = []
    if not hist:
        return ""
    lines = []
    for m in hist:
        who = "He said" if m.get("role") == "user" else "You answered"
        body = re.sub(r"\s+", " ", str(m.get("content"))).strip()[:900]
        if body:
            lines.append("%s: %s" % (who, body))
    if not lines:
        return ""
    return ("Earlier in this same chat, before this question:\n" + "\n".join(lines) +
            "\n\nAnswer this new question in that thread. If it refers to something above, "
            "use it; do not ask him to repeat what he already told you.\n\n")


def mark_agent_seen(conv: str) -> None:
    """Record how far into this chat the agent has been briefed.

    Stamped with the newest exchange on record, so the next agent turn in the same chat is given
    only what happened since — a front-layer answer in between still reaches it, and a long chat is
    not replayed in full on every turn.
    """
    try:
        os.makedirs(os.path.join(HERE, "ctx"), exist_ok=True)
        newest = max((float(m.get("at") or 0) for m in recall()), default=0.0)
        with open(_seen_path(conv), "w", encoding="utf-8") as f:
            json.dump({"at": newest}, f)
    except Exception:
        pass


@app.post("/cancel")
async def cancel(request: Request):
    """Stop the turn in flight at once.

    Waiting for the disconnect to be noticed costs about a second, which is fine as a backstop but
    not for a deliberate tap: this stops the agent, the speech requests and the token stream now.
    """
    if not authed(request) or not same_origin(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    try:
        payload = json.loads((await request.body()) or b"{}")
    except Exception:
        payload = {}
    if str(payload.get("turn") or "").startswith("page."):
        return await PAGE_TEXT.cancel(request, payload)
    # Which turn to stop, named either way: the machine's number or the id both sides agree on. With
    # several conversations running, an unnamed stop used to take the newest turn — somebody else's
    # answer. Ambiguity now stops nothing.
    want = payload.get("turn")
    want_tid = str(payload.get("tid") or "").strip()
    try:
        want = int(want) if str(want).strip().isdigit() else None
    except Exception:
        want = None
    with LIVE_LOCK, TURN_CHANS_LOCK:
        which = None
        if want is not None and want in LIVE_TURNS:
            which = want
        elif want_tid:
            for _t, _c in TURN_CHANS.items():
                if str(getattr(_c, "tid", "") or "") == want_tid:
                    which = _t
                    break
        elif len(LIVE_TURNS) == 1:
            which = next(iter(LIVE_TURNS))
        victim = LIVE_TURNS.get(which) if which is not None else None
    if victim is None:
        # A tap that stops nothing used to look identical to a tap that worked. Say so on the log
        # line, with what the page named and what was actually live.
        print("cancel missed: asked turn=%s tid=%r live=%s" % (want, want_tid, sorted(LIVE_TURNS)))
        return {"ok": True, "stopped": None}
    victim["yes"] = True
    invalidate_conv(victim.get("conv") or (which if isinstance(which, str) else None))
    print("cancel requested: stopping turn %s" % which)
    return {"ok": True, "stopped": which}


@app.post("/api/chat/stop")
async def api_chat_stop(request: Request):
    """The named stop, for the capsule's own button.

    One cancellation path decides everything and this shares it rather than growing a second one:
    the turn in flight is flagged, and the history counter moves so the turn can no longer be
    committed even if its worker is mid-tool and takes a moment to unwind.
    """
    return await cancel(request)


@app.post("/timeline")
async def timeline(request: Request):
    """The phone's own timeline marks, in the journal.

    Item 0 wants an endpoint-to-first-sound figure for real spoken turns, and the only place that
    number exists is the phone. Reading a phone console by hand is not a measurement, so the marks
    come here instead.
    """
    if not authed(request) or not same_origin(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    try:
        payload = json.loads((await request.body()) or b"{}")
    except Exception:
        return JSONResponse({"error": "bad body"}, status_code=400)
    marks = payload.get("marks")
    if isinstance(marks, list) and marks:
        print("phone: " + " | ".join(str(m)[:90] for m in marks[:12]))
    return {"ok": True}


# ======================================================================= the machine under the page
# The console's own window onto the box it runs on, and the one control on it that changes the
# machine. Telemetry, the extension toggles and the gateway restart all go through the platform's
# own CLI rather than writing config or signalling a process by hand, so the atomic config writer
# and the drain-before-restart that Hermes already has are the ones that run. The live server is
# its own systemd unit, NOT the gateway, so a restart issued from here cannot kill the process
# issuing it.
HERMES_BIN = (os.environ.get("JARVIS_HERMES_BIN") or os.environ.get("HERMES_BIN")
              or os.path.expanduser("~/.local/bin/hermes"))

# One agent run at a time in this process. Each question is run through the CLI against the page's
# own chat, and a run claims that chat while it lives: a second question started while the first is
# still working is refused outright ("this chat is open in another window"), and the page showed that
# refusal as an empty answer. Waiting here means the second question runs properly the moment the
# first finishes. The wait is bounded, so a wedged run cannot hold every later question for good.
AGENT_RUN_LOCK = threading.Lock()
AGENT_RUN_WAIT = 240.0
SYS_TTL = 4.0
_sys_cache = {}
# One manifest read behind the extensions panel, on the same clock as the rest of it. Keyed nothing:
# there is one plugins tree per home and the panel is the only reader.
_MANIFEST_INDEX = {"at": 0.0, "idx": {}}


def _cached(key, ttl, producer):
    now = time.time()
    hit = _sys_cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    val = producer()
    _sys_cache[key] = (now, val)
    return val


def _hermes(args, timeout=120):
    """Run the platform's own command. argv is a list and never a shell string, so nothing a name
    carries can become a second command. stdout is kept whole: a JSON payload truncated from the
    front is not JSON, and one of these commands returns a long array."""
    try:
        p = subprocess.run([HERMES_BIN] + list(args), capture_output=True, text=True, timeout=timeout)
        return {"ok": p.returncode == 0, "out": (p.stdout or "").strip(),
                "err": (p.stderr or "").strip()[-2000:]}
    except subprocess.TimeoutExpired:
        return {"ok": False, "out": "", "err": "timed out after %ss" % timeout}
    except Exception as e:
        return {"ok": False, "out": "", "err": str(e)[:300]}


def _cfg():
    import yaml
    with open(os.path.join(HERMES, "config.yaml"), encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _guard(request: Request) -> bool:
    return authed(request) and same_origin(request)

def _guard_owner(request: Request) -> bool:
    """A live screen may read, but only the operator's own scopes may administer."""
    return _guard(request) and auth_scope(request) in ("master", "full")


def _telemetry():
    import shutil

    def snap():
        with open("/proc/stat", encoding="utf-8") as f:
            p = [int(x) for x in f.readline().split()[1:]]
        idle = p[3] + (p[4] if len(p) > 4 else 0)
        return sum(p), idle

    t1, i1 = snap()
    time.sleep(0.15)                      # a rate needs two samples; a lifetime average lies
    t2, i2 = snap()
    cpu = round(100.0 * (1 - (i2 - i1) / max(1, t2 - t1)), 1)

    mem = {}
    with open("/proc/meminfo", encoding="utf-8") as f:
        for line in f:
            k, _, rest = line.partition(":")
            mem[k] = int(rest.split()[0]) * 1024
    mt, ma = mem.get("MemTotal", 0), mem.get("MemAvailable", 0)
    st, sf = mem.get("SwapTotal", 0), mem.get("SwapFree", 0)
    du = shutil.disk_usage("/")
    with open("/proc/uptime", encoding="utf-8") as f:
        up = int(float(f.read().split()[0]))
    return {
        "cpu": {"pct": cpu, "cores": os.cpu_count(), "load": [round(x, 2) for x in os.getloadavg()]},
        "mem": {"total": mt, "used": mt - ma, "swap_total": st, "swap_used": st - sf},
        "disk": {"total": du.total, "used": du.used, "free": du.free},
        "uptime": up,
    }


def _plugin_manifests():
    """Every plugin.yaml on this machine, indexed by directory name and by the manifest's own name.

    The panel needs three things the plugin list does not print — the kind, the tools and the hooks a
    plugin declares — and it needs them per plugin, not per category. They are read from the same
    manifests the loader reads, so the page can never claim a surface the plugin does not own. Kept
    on the same clock as the rest of this endpoint: a plugin installed while the page is open shows
    up with its own declaration on the next read rather than the last one. A manifest that will not
    parse is skipped, never guessed at."""
    now = time.time()
    if _MANIFEST_INDEX["at"] and now - _MANIFEST_INDEX["at"] < SYS_TTL:
        return _MANIFEST_INDEX["idx"]
    import yaml
    paths = glob.glob(os.path.join(HERMES_REPO, "plugins", "**", "plugin.yaml"), recursive=True)
    paths += glob.glob(os.path.join(HERMES, "plugins", "*", "plugin.yaml"))
    idx = {}
    for path in paths:
        try:
            with open(path, encoding="utf-8") as f:
                m = yaml.safe_load(f) or {}
        except Exception:
            continue
        if not isinstance(m, dict):
            continue
        def _names(key):
            return [str(x) for x in (m.get(key) or []) if isinstance(x, str)]
        entry = {"kind": str(m.get("kind") or ""), "tools": _names("provides_tools")[:40],
                 "hooks": (_names("provides_hooks") + _names("hooks"))[:40],
                 "dir": os.path.basename(os.path.dirname(path))}
        for key in {entry["dir"], str(m.get("name") or "")}:
            if key:
                idx.setdefault(key.lower().replace("_", "-"), []).append(entry)
    _MANIFEST_INDEX["at"], _MANIFEST_INDEX["idx"] = now, idx
    return idx


def _pick_manifest(candidates, description):
    """One manifest for one listed plugin.

    Two plugins legitimately share a slug — an image backend and its video twin — so a name alone
    chooses between them. The plugin's own description is the discriminator the machine already
    writes ("... image generation backend" / "... video generation backend"), so it decides, and a
    line that does not say falls back to the first candidate rather than pretending to know."""
    if len(candidates) == 1:
        return candidates[0]
    text = (description or "").lower()
    for word in ("video", "image", "audio", "platform", "provider"):
        if word in text:
            for c in candidates:
                if word in c["kind"].lower():
                    return c
    return candidates[0]


def _extensions():
    cfg = _cfg()
    mcp = []
    for name, c in (cfg.get("mcp_servers") or {}).items():
        if not isinstance(c, dict):
            continue
        url, cmd = str(c.get("url") or ""), str(c.get("command") or "")
        if url:
            # The transport is decided by how the endpoint is reached, not by a label anyone typed:
            # an /sse path is the older event-stream transport, anything else here is streamable
            # HTTP. Only the host is sent — the page has no use for a query string.
            transport = "sse" if url.rstrip("/").endswith("/sse") else "http"
            host = url.split("//")[-1].split("/")[0]
        else:
            transport, host = ("stdio" if cmd else "?"), ""
        mcp.append({"name": name, "enabled": bool(c.get("enabled", True)),
                    "transport": transport, "host": host,
                    "auth": str(c.get("auth") or "")})
    mcp.sort(key=lambda x: x["name"])

    plugins = []
    index = _plugin_manifests()
    pj = _hermes(["plugins", "list", "--json"], timeout=60)
    try:
        for p in json.loads(pj["out"] or "[]"):
            name = p.get("name")
            description = p.get("description", "") or ""
            hits = index.get(str(name or "").lower().replace("_", "-")) or []
            man = _pick_manifest(hits, description) if hits else {}
            plugins.append({"name": name, "enabled": p.get("status") == "enabled",
                            "version": p.get("version", ""), "source": p.get("source", ""),
                            "description": description, "kind": man.get("kind", ""),
                            "tools": man.get("tools", []), "hooks": man.get("hooks", []),
                            "declared": bool(hits)})
    except Exception:
        pass

    disabled = {str(x) for x in ((cfg.get("skills") or {}).get("disabled") or [])}
    skills = []
    # A skill's folder is its category, and some categories carry a second level (mlops/evaluation),
    # so the sweep recurses. A flat glob quietly missed every skill nested one level deeper than the
    # rest: six skills the machine has and the panel never showed, with nothing on screen to say so.
    root = os.path.join(HERMES, "skills")
    for path in glob.glob(os.path.join(root, "**", "SKILL.md"), recursive=True):
        rel = os.path.relpath(os.path.dirname(path), root)
        parts = rel.split(os.sep)
        skills.append({"name": parts[-1], "enabled": parts[-1] not in disabled,
                       "category": parts[0], "group": rel.replace(os.sep, "/"),
                       "nested": len(parts) > 2})
    skills = [s for s in skills if s["name"] and s["name"] != "skills"]
    skills.sort(key=lambda x: (x["category"], x["name"]))
    return {"mcp": mcp, "plugins": plugins, "skills": skills}


def _automations():
    with open(os.path.join(HERMES, "cron", "jobs.json"), encoding="utf-8") as f:
        d = json.load(f)
    jobs = d if isinstance(d, list) else (d.get("jobs") or list(d.values()) if isinstance(d, dict) else [])
    out = []
    for j in jobs:
        if not isinstance(j, dict):
            continue
        sch = j.get("schedule") or {}
        rep = j.get("repeat") or {}
        out.append({"id": j.get("id") or "",
                    "name": j.get("name") or j.get("id") or "job",
                    "when": sch.get("display") or sch.get("expr") or sch.get("kind") or "",
                    # The schedule's own pieces, so the page can say "Daily at 7:00 AM" instead of
                    # printing the expression back at him. The raw fields are what the scheduler
                    # actually holds; nothing here is derived from a display string.
                    "kind": sch.get("kind") or "",
                    "expr": sch.get("expr") or "",
                    "minutes": sch.get("minutes") or 0,
                    "enabled": bool(j.get("enabled", True)),
                    "state": j.get("state") or "",
                    "last_status": j.get("last_status") or "",
                    "last_run_at": j.get("last_run_at") or "",
                    "next_run_at": j.get("next_run_at") or "",
                    "failure_streak": int(j.get("failure_streak") or 0),
                    "last_error": str(j.get("last_error") or "")[:300],
                    "runs": int(rep.get("completed") or 0),
                    "script": str(j.get("script") or ""),
                    "no_agent": bool(j.get("no_agent")),
                    "deliver": j.get("deliver") or ""})
    out.sort(key=lambda x: (not x["enabled"], x["when"]))
    return out


HERMES_PY = os.path.join(HERMES, "hermes-agent", "venv", "bin", "python")
HERMES_REPO = os.path.join(HERMES, "hermes-agent")


def _env_map():
    """The .env file as a plain dict. Used only to answer "is this channel configured" — no value
    is ever returned to the page."""
    out = {}
    try:
        with open(os.path.join(HERMES, ".env"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                out[k.strip()] = v.strip().strip('"').strip("'")
    except Exception:
        pass
    return out


def _platform_registry():
    """The platforms this install can connect, read from the platform's own registry so a
    platform added upstream shows up here without a second list to keep in step."""
    def build():
        import tempfile
        code = (
            "import json, sys\n"
            "from hermes_cli.gateway_setup_wizard import _all_platforms\n"
            "out = []\n"
            "for p in _all_platforms():\n"
            "    out.append({'key': p.get('key') or '', 'label': p.get('label') or '',\n"
            "                'emoji': p.get('emoji') or '', 'var': p.get('token_var') or '',\n"
            "                'steps': [str(s) for s in (p.get('setup_instructions') or [])]})\n"
            "open(sys.argv[1], 'w').write(json.dumps(out))\n")
        fd, tmp = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        try:
            subprocess.run([HERMES_PY, "-c", code, tmp], cwd=HERMES_REPO,
                           capture_output=True, text=True, timeout=90)
            with open(tmp, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []
        finally:
            try:
                os.unlink(tmp)
            except Exception:
                pass
    return _cached("platforms", 300.0, build)


DISPLAY_LABELS = {
    "whatsapp": ("WhatsApp", "\U0001F4AC"), "whatsapp_cloud": ("WhatsApp Cloud API", "\U0001F4AC"),
    "telegram": ("Telegram", "\u2708\ufe0f"), "email": ("Email", "\U0001F4E7"),
    "slack": ("Slack", "\U0001F4AC"), "discord": ("Discord", "\U0001F3AE"),
    "webhook": ("Webhook", "\U0001F517"), "signal": ("Signal", "\U0001F4E1"),
    "matrix": ("Matrix", "\U0001F510"), "mattermost": ("Mattermost", "\U0001F4AC"),
}


def _channels():
    """Every messaging channel this install knows, with its real state: connected, configured but
    not enabled, or available to connect. Read from the config, the .env and the gateway's own
    contact directory — never guessed by the panel."""
    cfg = _cfg()
    plats = cfg.get("platforms") or {}
    env = _env_map()
    reg = {str(p.get("key")): p for p in _platform_registry() if p.get("key")}
    try:
        with open(os.path.join(HERMES, "channel_directory.json"), encoding="utf-8") as f:
            contacts = (json.load(f) or {}).get("platforms") or {}
    except Exception:
        contacts = {}
    keys = list(reg.keys()) + [k for k in plats if k not in reg]
    out = []
    for key in dict.fromkeys(keys):
        conf = plats.get(key) or {}
        if not isinstance(conf, dict):
            conf = {}
        r = reg.get(key) or {}
        var = str(r.get("var") or "")
        label, emoji = DISPLAY_LABELS.get(
            key, (r.get("label") or key.replace("_", " ").title(), r.get("emoji") or ""))
        # A platform the config carries is on unless it says otherwise; one it does not carry at
        # all is simply available to connect. That matches how the gateway reads the same file,
        # so a channel the operator is actually messaging on never shows as off.
        in_cfg = key in plats
        enabled = bool(conf.get("enabled", True)) if in_cfg else False
        configured = bool(env.get(var) or os.environ.get(var)) if var else in_cfg
        state = "off" if not enabled else ("setup" if not configured else "connected")
        out.append({"key": key, "label": label, "emoji": emoji, "enabled": enabled,
                    "configured": configured, "state": state,
                    "contacts": len(contacts.get(key) or []),
                    "steps": list(r.get("steps") or []),
                    "command": "hermes gateway setup"})
    out.sort(key=lambda c: (c["state"] != "connected", c["state"] != "setup", c["label"].lower()))
    return {"gateway": _gateway().get("gateway") or "unknown", "channels": out}


@app.get("/sys/channels")
def sys_channels(request: Request):
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        return JSONResponse({"ok": True, "channels": _cached("chan", SYS_TTL, _channels)})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


# --- Profile Files: the identity and knowledge files, opened read-only ---------------------------
# Nothing on this path writes: the viewer reports a missing file as missing rather than creating
# it, so the page cannot corrupt what it opens.
PROFILE_FILES = [
    ("note", "note.md", "Notes", os.path.join(HERMES, "notes", "note.md")),
    ("soul", "agent_soul", "Agent Soul", os.path.join(HERMES, "SOUL.md")),
    ("memory", "memory", "Memory", os.path.join(HERMES, "memories", "MEMORY.md")),
    ("user", "user_profile", "User Notes", os.path.join(HERMES, "memories", "USER.md")),
    ("persona", "system", "System Notes", os.path.join(HERE, "persona", "system.txt")),
]


def _profile_files():
    out = []
    for fid, name, label, path in PROFILE_FILES:
        try:
            st = os.stat(path)
            out.append({"id": fid, "name": name, "label": label, "exists": True,
                        "bytes": st.st_size, "mtime": int(st.st_mtime)})
        except Exception:
            out.append({"id": fid, "name": name, "label": label, "exists": False,
                        "bytes": 0, "mtime": 0})
    return out


@app.get("/sys/profile-files")
def sys_profile_files(request: Request):
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        return JSONResponse({"ok": True, "files": _profile_files()})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


@app.get("/sys/profile-file")
def sys_profile_file(request: Request, id: str = ""):
    """One profile file, read-only. There is no write path here by design."""
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    entry = next((f for f in PROFILE_FILES if f[0] == id), None)
    if not entry:
        return JSONResponse({"ok": False, "error": "unknown file"}, status_code=404)
    fid, name, label, path = entry
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read(400000)
        return JSONResponse({"ok": True, "id": fid, "name": name, "label": label, "text": text})
    except FileNotFoundError:
        return JSONResponse({"ok": True, "id": fid, "name": name, "label": label,
                             "text": "", "missing": True})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


@app.get("/sys/telemetry")
def sys_telemetry(request: Request):
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        return JSONResponse({"ok": True, "telemetry": _cached("tel", 2.0, _telemetry)})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


@app.get("/sys/extensions")
def sys_extensions(request: Request):
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        return JSONResponse({"ok": True, "extensions": _cached("ext", SYS_TTL, _extensions)})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


@app.get("/sys/automations")
def sys_automations(request: Request):
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        return JSONResponse({"ok": True, "jobs": _cached("auto", SYS_TTL, _automations)})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


def _toggle_ok_name(name):
    """A name only ever reaches a command as its own argv element, and only from this alphabet."""
    return bool(name) and len(name) <= 64 and all(
        c in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-" for c in name)


def _do_extension_toggle(kind, name, on):
    """Flip one MCP server, plugin or skill through the platform's own write. `hermes config set`
    for the two config-backed kinds, `hermes plugins enable|disable` for a plugin, so the state
    on disk is the state changed and never a copy of it kept by this process."""
    if kind == "mcp":
        res = _hermes(["config", "set", "mcp_servers.%s.enabled" % name, "true" if on else "false"])
    elif kind == "plugin":
        res = _hermes(["plugins", "enable" if on else "disable", name])
    else:
        cur = {str(x) for x in ((_cfg().get("skills") or {}).get("disabled") or [])}
        if on:
            cur.discard(name)
        else:
            cur.add(name)
        res = _hermes(["config", "set", "skills.disabled", json.dumps(sorted(cur)), "--force"])
    _sys_cache.pop("ext", None)
    print("ext toggle: %s %s -> %s ok=%s" % (kind, name, "on" if on else "off", res["ok"]))
    return res


async def _extension_toggle(request: Request, kind):
    """Shared handler: one guard, one validation, one answer shape for every /api toggle route."""
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        body = json.loads((await request.body()).decode() or "{}")
    except Exception:
        return JSONResponse({"ok": False, "error": "bad body"}, status_code=400)
    name, on = str(body.get("name") or ""), bool(body.get("enabled"))
    if not _toggle_ok_name(name):
        return JSONResponse({"ok": False, "error": "bad request"}, status_code=400)
    res = _do_extension_toggle(kind, name, on)
    return JSONResponse({"ok": res["ok"], "result": (res["out"] or res["err"])[:400]})


@app.post("/sys/extensions/toggle")
async def sys_toggle(request: Request):
    """The drawer's original endpoint, kept so an older copy of the page keeps working."""
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        body = json.loads((await request.body()).decode() or "{}")
    except Exception:
        return JSONResponse({"ok": False, "error": "bad body"}, status_code=400)
    kind, name, on = body.get("kind"), str(body.get("name") or ""), bool(body.get("enabled"))
    if kind not in ("mcp", "plugin", "skill") or not _toggle_ok_name(name):
        return JSONResponse({"ok": False, "error": "bad request"}, status_code=400)
    res = _do_extension_toggle(kind, name, on)
    return JSONResponse({"ok": res["ok"], "result": (res["out"] or res["err"])[:400]})


@app.post("/api/skills/toggle")
async def api_skills_toggle(request: Request):
    return await _extension_toggle(request, "skill")


@app.post("/api/mcp/toggle")
async def api_mcp_toggle(request: Request):
    return await _extension_toggle(request, "mcp")


@app.post("/api/plugins/toggle")
async def api_plugins_toggle(request: Request):
    return await _extension_toggle(request, "plugin")


@app.post("/api/automations/toggle")
async def api_automations_toggle(request: Request):
    """Pause or resume one scheduled job. The write is the scheduler's own command, so the job's
    own state is what changes rather than a copy the panel keeps."""
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        body = json.loads((await request.body()).decode() or "{}")
    except Exception:
        return JSONResponse({"ok": False, "error": "bad body"}, status_code=400)
    job_id, on = str(body.get("id") or "").strip(), bool(body.get("enabled"))
    if not job_id or len(job_id) > 64 or not all(
            c in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in job_id):
        return JSONResponse({"ok": False, "error": "bad request"}, status_code=400)
    res = _hermes(["cron", "resume" if on else "pause", job_id], timeout=60)
    _sys_cache.pop("auto", None)
    print("automation toggle: %s -> %s ok=%s" % (job_id, "on" if on else "off", res["ok"]))
    return JSONResponse({"ok": res["ok"], "result": (res["out"] or res["err"])[:400]})


@app.post("/sys/restart")
async def sys_restart(request: Request):
    """Restart the agent gateway. The page asks first and only calls this on that yes. The gateway
    is its own unit and the platform's restart drains the turns in flight before the kill."""
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    res = _hermes(["gateway", "restart"], timeout=180)
    print("sys restart: gateway restart ok=%s" % res["ok"])
    return JSONResponse({"ok": res["ok"], "result": (res["out"] or res["err"])[:400]})


# ============================================================ the preferences, the persona, the node
# Settings, Persona and the Profile page are not decoration: each one reads and writes real state.
# The voice this page speaks with and how fast it speaks are the values the speech call itself
# uses; the system instructions are the text the fast layer answers from; the memory entries are
# the file the agent actually reads; the startup mode is what a new conversation arms. Every write
# lands in a file an operator can open, and every destructive one takes a timestamped copy first.

BOOT = time.time()
PREFS_FILE = os.path.join(HERMES, "jarvis_live_prefs.json")
PERSONA_FILE = os.path.join(HERE, "persona", "system.txt")
MEMORY_FILES = [("memory", os.path.join(HERMES, "memories", "MEMORY.md")),
                ("profile", os.path.join(HERMES, "memories", "USER.md"))]
MEM_SEP = "\u00a7"
PREFS_DEFAULTS = {
    "voice": VOICE,
    "voice_title": "jarvis",
    "speed": 1.0,
    "default_mode": "voice",
    # His node. Kept as data rather than a string in the page so the panel can correct it without
    # a rebuild, and so the local clock shown beside it is derived, not typed.
    "node": {"location": "Kampala, Uganda", "utc_offset": 3},
}


def _prefs():
    d = json.loads(json.dumps(PREFS_DEFAULTS))
    try:
        with open(PREFS_FILE, encoding="utf-8") as f:
            stored = json.load(f) or {}
        for k, v in stored.items():
            if k == "node" and isinstance(v, dict):
                d["node"].update(v)
            else:
                d[k] = v
    except Exception:
        pass
    return d


def _save_prefs(patch):
    d = _prefs()
    d.update(patch or {})
    tmp = PREFS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
    os.replace(tmp, PREFS_FILE)
    return d


def _hm12(t):
    """12-hour clock without the leading zero strftime insists on: 9:05 AM, not 09:05 AM."""
    h = int(t.tm_hour) % 12 or 12
    return "%d:%02d %s" % (h, int(t.tm_min), "AM" if int(t.tm_hour) < 12 else "PM")


def _backup(path):
    """Copy a file before the page overwrites it. Returns the copy's path, or '' if there was
    nothing to copy."""
    try:
        if not os.path.exists(path):
            return ""
        dst = "%s.bak-page-%s" % (path, time.strftime("%Y%m%d-%H%M%S", time.gmtime()))
        with open(path, "rb") as a, open(dst, "wb") as b:
            b.write(a.read())
        return dst
    except Exception:
        return ""


def _persona_load():
    """The system instructions the fast layer answers from, read from the file the page edits.
    Seeds the file from the built-in text the first time, so the value on screen is never invented
    and editing it changes what he is actually talking to."""
    global SYSTEM
    try:
        if not os.path.exists(PERSONA_FILE):
            os.makedirs(os.path.dirname(PERSONA_FILE), exist_ok=True)
            with open(PERSONA_FILE, "w", encoding="utf-8") as f:
                f.write(SYSTEM)
            return
        with open(PERSONA_FILE, encoding="utf-8") as f:
            text = f.read().strip()
        if text:
            SYSTEM = text
    except Exception as e:
        print("persona load failed:", str(e)[:160])


def _memory_blocks(path):
    """The memory file as its own entries. Both memory files are written with the separator on its
    own line, which is the only structure they have."""
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    except Exception:
        return []
    parts = re.split(r"\n\s*" + re.escape(MEM_SEP) + r"\s*\n", raw)
    return [p.strip() for p in parts if p.strip()]


def _memory_entries():
    out = []
    for kind, path in MEMORY_FILES:
        for i, text in enumerate(_memory_blocks(path)):
            out.append({"id": "%s:%d" % (kind, i), "kind": kind, "text": text,
                        "chars": len(text)})
    return out


VOICE_TTL = 900.0


def _voice_options():
    """His own cloned voices, straight from the account that owns them, so the dropdown can only
    offer a voice that exists. A failed call returns just the one in use rather than an empty
    list, because an empty list would read as 'no voices'."""
    cur = _prefs()
    fallback = [{"id": cur.get("voice") or VOICE, "title": cur.get("voice_title") or "jarvis",
                 "state": "current"}]
    key = FISH_KEY
    if not key:
        return fallback
    try:
        req = urllib.request.Request("https://api.fish.audio/model?self=true&page_size=50",
                                     headers={"Authorization": "Bearer " + key})
        with urllib.request.urlopen(req, timeout=12) as r:
            d = json.loads(r.read().decode())
        items = [{"id": m.get("_id"), "title": m.get("title") or "untitled",
                  "state": m.get("state") or ""} for m in (d.get("items") or []) if m.get("_id")]
        return items or fallback
    except Exception as e:
        print("voice list failed:", str(e)[:160])
        return fallback


def _node():
    p = _prefs().get("node") or {}
    off = float(p.get("utc_offset") or 0)
    t = time.gmtime(time.time() + off * 3600)
    return {"location": p.get("location") or "unknown", "utc_offset": off,
            "local_time": _hm12(t), "local_day": time.strftime("%a %d %b", t)}


def _gateway():
    """Is the agent actually reachable? Two independent signals: the shim's socket, and the unit
    that runs it. Reading only one would call a dead gateway 'up' whenever the socket outlived
    it, or the reverse."""
    shim = False
    try:
        s = socket.create_connection(("127.0.0.1", 8140), timeout=1.5)
        s.close()
        shim = True
    except Exception:
        pass
    try:
        act = subprocess.run(["systemctl", "--user", "is-active", "hermes-gateway.service"],
                             capture_output=True, text=True, timeout=6).stdout.strip()
    except Exception:
        act = "unknown"
    return {"shim": shim, "gateway": act or "unknown"}


def _session_info():
    with HISTORY_LOCK:
        msgs = len(HISTORY)
    return {"id": SESSION.get("id") or "", "turn": TURN.get("n") or 0, "messages": msgs,
            "live": len(LIVE_TURNS), "up_s": int(time.time() - BOOT)}


def _runtime_load():
    """Apply the stored preferences to the running process. Called once at import and again on
    Reload Config, so the button and a restart do the same thing."""
    global VOICE, SPEED, FISH_KEY
    p = _prefs()
    if p.get("voice"):
        VOICE = str(p["voice"])
    try:
        SPEED = max(0.75, min(1.5, float(p.get("speed") or 1.0)))
    except Exception:
        SPEED = 1.0
    FISH_KEY = env("FISH_AUDIO_API_KEY") or env("FISH_API_KEY")
    _persona_load()


@app.get("/sys/persona")
def sys_persona(request: Request):
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        text = SYSTEM
        return JSONResponse({"ok": True, "system": text, "chars": len(text),
                             "source": PERSONA_FILE,
                             "revised": int(os.path.getmtime(PERSONA_FILE))
                             if os.path.exists(PERSONA_FILE) else 0})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


@app.post("/sys/persona")
async def sys_persona_save(request: Request):
    """Write the instructions the fast layer answers from. The previous text is copied aside
    first, so a mistake here is one file away from undone."""
    global SYSTEM
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        body = json.loads((await request.body()).decode() or "{}")
    except Exception:
        return JSONResponse({"ok": False, "error": "bad body"}, status_code=400)
    text = str(body.get("system") or "").strip()
    if not text:
        return JSONResponse({"ok": False, "error": "empty"}, status_code=400)
    if len(text) > 20000:
        return JSONResponse({"ok": False, "error": "too long"}, status_code=400)
    try:
        os.makedirs(os.path.dirname(PERSONA_FILE), exist_ok=True)
        keep = _backup(PERSONA_FILE)
        tmp = PERSONA_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, PERSONA_FILE)
        SYSTEM = text
        print("sys persona: saved %d chars (previous kept at %s)" % (len(text), keep or "none"))
        return JSONResponse({"ok": True, "chars": len(text), "backup": os.path.basename(keep or "")})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


@app.get("/sys/memory")
def sys_memory(request: Request):
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        return JSONResponse({"ok": True, "entries": _memory_entries()})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


@app.post("/sys/memory/delete")
async def sys_memory_delete(request: Request):
    """Drop one stored memory entry. The file is copied aside first and rewritten atomically; the
    agent's own memory tool may still hold its copy in memory, so the file on disk is the target
    and the next read is what changes."""
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        body = json.loads((await request.body()).decode() or "{}")
    except Exception:
        return JSONResponse({"ok": False, "error": "bad body"}, status_code=400)
    try:
        kind, _, idx = str(body.get("id") or "").partition(":")
        idx = int(idx)
    except Exception:
        return JSONResponse({"ok": False, "error": "bad id"}, status_code=400)
    path = dict(MEMORY_FILES).get(kind)
    if not path:
        return JSONResponse({"ok": False, "error": "bad id"}, status_code=400)
    blocks = _memory_blocks(path)
    if idx < 0 or idx >= len(blocks):
        return JSONResponse({"ok": False, "error": "no such entry"}, status_code=404)
    gone = blocks.pop(idx)
    try:
        keep = _backup(path)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(("\n" + MEM_SEP + "\n").join(blocks) + "\n")
        os.replace(tmp, path)
        print("sys memory: removed %s (%d -> %d), previous kept at %s"
              % (body.get("id"), len(blocks) + 1, len(blocks), keep or "none"))
        return JSONResponse({"ok": True, "kept": len(blocks), "removed": gone[:120],
                             "backup": os.path.basename(keep or "")})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


@app.get("/sys/settings")
def sys_settings(request: Request):
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        p = _prefs()
        return JSONResponse({"ok": True, "settings": {
            "voice": VOICE, "voice_title": p.get("voice_title") or "jarvis",
            "voices": _cached("voices", VOICE_TTL, _voice_options),
            "speed": SPEED, "model": FISH_MODEL,
            "ui": _ui_config(),
            "scope": (device_entries().get(cookie_token(request)) or {}).get("scope") or "master",
            "cache_entries": len(_sys_cache)}})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


@app.post("/sys/settings/voice")
async def sys_settings_voice(request: Request):
    """Switch the voice this page speaks with. Only an id the account actually owns is accepted,
    when the account list is readable; a well-formed id is the fallback, not the rule."""
    global VOICE
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        body = json.loads((await request.body()).decode() or "{}")
    except Exception:
        return JSONResponse({"ok": False, "error": "bad body"}, status_code=400)
    vid = str(body.get("voice") or "").strip()
    if not re.fullmatch(r"[0-9a-fA-F]{32}", vid):
        return JSONResponse({"ok": False, "error": "bad voice id"}, status_code=400)
    options = _cached("voices", VOICE_TTL, _voice_options)
    title = next((o["title"] for o in options if o["id"] == vid), "")
    if not title and len(options) > 1:
        return JSONResponse({"ok": False, "error": "not one of your voices"}, status_code=400)
    VOICE = vid
    _save_prefs({"voice": vid, "voice_title": title or (VID_TITLES.get(vid) or "voice")})
    print("sys settings: voice -> %s (%s)" % (vid, title or "?"))
    return JSONResponse({"ok": True, "voice": vid, "title": title})


@app.post("/sys/settings/speed")
async def sys_settings_speed(request: Request):
    """Speech rate. Written to the value the synthesis call sends, not to the player's playback
    speed, so the caption pacing that rides the audio clock stays correct."""
    global SPEED
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        body = json.loads((await request.body()).decode() or "{}")
    except Exception:
        return JSONResponse({"ok": False, "error": "bad body"}, status_code=400)
    try:
        sp = round(max(0.75, min(1.5, float(body.get("speed")))), 2)
    except Exception:
        return JSONResponse({"ok": False, "error": "bad speed"}, status_code=400)
    SPEED = sp
    _save_prefs({"speed": sp})
    print("sys settings: speed -> %s" % sp)
    return JSONResponse({"ok": True, "speed": sp})


@app.post("/sys/settings/clear-cache")
def sys_clear_cache(request: Request):
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    n = len(_sys_cache)
    _sys_cache.clear()
    print("sys settings: cleared %d cached reads" % n)
    return JSONResponse({"ok": True, "dropped": n})


@app.post("/sys/settings/reload")
def sys_reload_config(request: Request):
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    _sys_cache.clear()
    _runtime_load()
    return JSONResponse({"ok": True, "voice": VOICE, "speed": SPEED,
                         "persona_chars": len(SYSTEM),
                         "key": bool(FISH_KEY)})


@app.get("/sys/profile")
def sys_profile(request: Request):
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        # No model field: the console does not name the model it runs on, and a name it never showed
        # is a name it cannot leak onto a panel later.
        return JSONResponse({"ok": True, "session": _session_info(), "node": _node(),
                             "gateway": _gateway(),
                             "default_mode": _prefs().get("default_mode") or "voice"})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


@app.post("/sys/profile/mode")
async def sys_profile_mode(request: Request):
    """The mode a new conversation starts in, stored on the machine so it survives the page."""
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        body = json.loads((await request.body()).decode() or "{}")
    except Exception:
        return JSONResponse({"ok": False, "error": "bad body"}, status_code=400)
    mode = str(body.get("mode") or "")
    if mode not in ("text", "voice"):
        return JSONResponse({"ok": False, "error": "bad mode"}, status_code=400)
    _save_prefs({"default_mode": mode})
    print("sys profile: default mode -> %s" % mode)
    return JSONResponse({"ok": True, "mode": mode})


VID_TITLES = {"79554ca723f442a3af718d5aee6751ab": "jarvis",
              "25770f61978a494d967660fa504cf2bb": "ultron"}

_runtime_load()


@app.get("/healthz")
def healthz():
    # `turns` is how many turns are in flight right now. It exists so a stop can WAIT for them:
    # tools/drain.sh runs as ExecStop and polls this before the kill signal lands, so a restart
    # costs nothing he was watching. Only the count is reported, never a question or an answer.
    return JSONResponse({"ok": True, "turns": len(LIVE_TURNS)})

# Staging-only test runner. Fixed commands, no arguments from the caller, key in a header.
# Enabled only when JARVIS_DEV_RUNNER_KEY is set in the unit's environment (staging only).
_DEV_COMMANDS = {
    "suites": ["{py}", "tools/verify_intelligent_ui.py", "--browser", "/usr/bin/google-chrome",
               "--report", "/tmp/dev-suites.json"],
    "answers": ["{py}", "tools/generative_probe.py", "--base", "https://stage.battemohammad.com",
                "--cookie-file", "/home/ubuntu/.hermes/cache/scratch/tui-evidence/cookie.txt",
                "--report", "/tmp/dev-answers.json", "--allow-cancel"],
}
_DEV_REPORTS = {"suites-report": "/tmp/dev-suites.json", "answers-report": "/tmp/dev-answers.json",
                "answers-md": "/tmp/dev-answers.answers.md"}


@app.get("/api/turns/events")
def api_turn_events(request: Request):
    """What the machine recorded a turn doing, whether or not a page was open at the time."""
    if not _guard(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    conv = str(request.query_params.get("conv") or "").strip()
    tid = str(request.query_params.get("tid") or "").strip()
    if not re.fullmatch(r"[0-9a-f]{32}", conv or ""):
        return JSONResponse({"ok": False, "error": "bad conversation"}, status_code=400)
    live = None
    try:
        with TURN_CHANS_LOCK:
            for t, c in TURN_CHANS.items():
                # The caller may name the turn either way: the machine's number or the name both sides
                # agree on. Both mean the same turn, so both must answer.
                named = (not tid) or str(t) == tid or str(getattr(c, "tid", "")) == tid
                if str(getattr(c, "conv", "")) == conv and named and live is None:
                    live = {"turn": str(t), "tid": str(getattr(c, "tid", "") or ""),
                            "status": str(getattr(c, "status", "")),
                            "steps": [str(x) for x in (getattr(c, "steps", None) or [])],
                            "started": float(getattr(c, "started", 0) or 0), "live": True}
    except Exception:
        live = None
    rows = _exec_rows(conv, tid or None, limit=20)
    if live and (not tid or live["turn"] == tid):
        if not rows or rows[-1].get("turn") != live["turn"]:
            rows = rows + [live]
    return JSONResponse({"ok": True, "conv": conv, "records": rows})


@app.get("/build")
def build_stamp():
    """Which frontend this service is serving, so a stale page can be told from a fresh one.

    The stamps are the ones baked into the built page's own asset URLs. A page that loaded a
    different stamp to the one answered here is a page running older code, and it can say so
    without anything being cleared.
    """
    out = {"js": "", "css": "", "built": 0}
    try:
        page = open(os.path.join(HERE, "index_v1.html"), encoding="utf-8").read()
        for key, name in (("js", "v1.js"), ("css", "v1.css")):
            m = re.search(r"/static/" + re.escape(name) + r"\?v=([0-9a-f]+)", page)
            if m:
                out[key] = m.group(1)
        out["built"] = int(os.path.getmtime(os.path.join(HERE, "index_v1.html")))
    except Exception as exc:
        out["error"] = repr(exc)[:80]
    return JSONResponse(out)


@app.get("/favicon.ico")
def favicon():
    path = os.path.join(HERE, "static", "favicon.ico")
    if not os.path.exists(path):
        return JSONResponse({"error": "none"}, status_code=404)
    return FileResponse(path, media_type="image/x-icon",
                        headers={"Cache-Control": "public, max-age=86400"})


@app.post("/tv", response_class=HTMLResponse)
async def tv_pair(request: Request):
    """Pair one screen with a six digit code, so the plain address works on it afterwards.

    The code is short because a TV remote is the input device. Five wrong tries from one
    address blocks that address for fifteen minutes, and a code is spent on first use.
    """
    ip = client_ip(request)
    if tv_blocked(ip):
        return gate("Too many wrong codes. Try again in fifteen minutes.")
    try:
        raw = (await request.body()).decode("utf-8", "replace")
    except Exception:
        raw = ""
    # Parsed by hand: request.form() needs python-multipart, which this virtual environment
    # does not carry, and a silent failure there would reject a correct code.
    sent = urllib.parse.parse_qs(raw).get("code", [""])[0]
    code = re.sub(r"\D", "", str(sent))[:6]
    live = read_code()
    if code and live and code == live:
        # A code is minted by the operator (or by the page he is already signed in to) and is single-use
        # for one hour, so whoever redeems it is him or someone he handed it to on purpose. It used to
        # hand out the TV's scope, which left every phone that paired this way unable to type: the app
        # answered but refused every request needing work.
        tok = add_device(pair_label(request), "full")
        clear_code()                       # one screen per code
        r = RedirectResponse("/", status_code=302)
        r.set_cookie(COOKIE, tok, max_age=COOKIE_MAX_AGE, httponly=True, secure=True,
                     samesite="lax")
        return r
    tv_fail(ip)
    return gate("That code is not right. Check it and try again.")


@app.post("/tv/mint")
def tv_mint(request: Request):
    """Mint a pairing code. Loopback only: this is for JARVIS on the machine, not the network."""
    if request.headers.get("cf-connecting-ip"):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1"):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return {"code": mint_code(), "seconds": CODE_TTL}


def device_lines():
    """The device file as raw lines, oldest first. Reading never rewrites it."""
    try:
        with open(DEVICES_FILE, encoding="utf-8") as f:
            return [l for l in f.read().splitlines() if l.strip()]
    except Exception:
        return []


@app.get("/devices")
def devices_list(request: Request):
    """What screens hold a session. The tokens themselves are never returned, only labels."""
    if not authed(request) or not same_origin(request):
        return JSONResponse({"detail": "not authorised"}, status_code=403)
    mine = cookie_token(request)
    out = []
    for i, line in enumerate(device_lines(), 1):
        parts = [x.strip() for x in line.split("\t")]
        tok = parts[0]
        out.append({
            "index": i,
            "label": (parts[1] if len(parts) > 1 and parts[1] else "unnamed (legacy)"),
            "scope": (parts[2] if len(parts) > 2 and parts[2] else "full"),
            "added": (parts[3] if len(parts) > 3 else ""),
            "current": bool(mine) and (hmac.compare_digest(tok, mine) or hmac.compare_digest(tok, _tok_hash(mine))),
        })
    out.reverse()                       # newest first, but index stays the file position
    return {"devices": out, "on_master_key": not mine}


@app.post("/devices/revoke")
async def devices_revoke(request: Request):
    """Drop one paired screen's key. The master token is untouched, so this cannot lock him out."""
    if not authed(request) or not same_origin(request):
        return JSONResponse({"detail": "not authorised"}, status_code=403)
    try:
        body = json.loads((await request.body()).decode("utf-8") or "{}")
    except Exception:
        body = {}
    try:
        idx = int(body.get("index") or 0)
    except Exception:
        idx = 0
    lines = device_lines()
    if idx < 1 or idx > len(lines):
        return JSONResponse({"detail": "no such screen"}, status_code=400)
    removed = lines.pop(idx - 1)
    try:
        with DEVICES_LOCK:
            _device_write([[x.strip() for x in ln.split("\t")] for ln in lines])
    except Exception as e:
        return JSONResponse({"detail": "could not write: %s" % str(e)[:80]}, status_code=500)
    print("revoked a paired screen: %s... (%d left)" % (removed.split("\t")[0][:6], len(lines)))
    return {"ok": True, "remaining": len(lines)}


# The console's own policy. Its one piece of inline script — the audio engine — is carried with a
# placeholder and given a fresh nonce on every response, so the policy can forbid inline script
# outright without the engine being rewritten. It goes out as Report-Only first: enforcement waits
# until a real voice turn has run under it and been seen to raise nothing.
PAGE_CSP = (
    "default-src 'self'; "
    # blob: in script-src is not decoration: Chrome checks AudioWorklet.addModule() against
    # script-src, and the capture worklet is built from a blob URL. Without it the microphone dies
    # silently under enforcement while Report-Only, which blocks nothing, shows nothing wrong.
    "script-src 'self' 'nonce-{nonce}' blob:; "
    "style-src 'self' 'unsafe-inline'; "
    # https: in img-src because a panel may carry a picture from the web. Without it every such
    # image is blocked silently and the panel renders as a frame with nothing in it.
    "img-src 'self' data: blob: https:; "
    "media-src 'self' blob:; "
    "connect-src 'self'; "
    "worker-src 'self' blob:; "
    # frame-src carries this origin (the OpenUI runtime is service-local), the widget origin and the YouTube no-cookie player: a video panel is an
    # embed, and an embed the policy has not allowed renders as an empty frame.
    "frame-src 'self' https://" + WIDGETS.host() + " https://www.youtube-nocookie.com; "
    "frame-ancestors 'none'; "
    "object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'self'"
)


def page_response(html, report_only=True):
    """Serve a console page under its policy, with a fresh nonce for the engine."""
    nonce = secrets.token_urlsafe(18)
    headers = {"Cache-Control": "no-store, must-revalidate", "Pragma": "no-cache"}
    headers["Content-Security-Policy-Report-Only" if report_only
            else "Content-Security-Policy"] = PAGE_CSP.format(nonce=nonce)
    # frame-ancestors in the policy covers modern browsers; the header covers anything that ignores
    # it. nosniff stops a response being read as a type it is not, and no-referrer keeps the page's
    # address out of every request it makes.
    headers["X-Content-Type-Options"] = "nosniff"
    headers["Referrer-Policy"] = "no-referrer"
    return HTMLResponse(html.replace("{{CSP_NONCE}}", nonce), headers=headers)


def console_page():
    """The console. One page, one address, one policy.

    index.html is deliberately NOT what this serves. build_v1.py reads its engine block as the
    engine of record and refuses to build if those lines drift, so that file is build input, not a
    surface. It stays on disk and is not reachable.
    """
    with open(os.path.join(HERE, "index_v1.html"), encoding="utf-8") as f:
        # Enforced, not reported. The policy ran in Report-Only first and raised nothing across a
        # real turn, the audio worklet's blob module, and a widget frame, with a control proving
        # the collector was live. An injected inline script is refused.
        return page_response(f.read(), report_only=False)


@app.get("/", response_class=HTMLResponse)
def index(request: Request, k: str = ""):
    """The console, at the root.

    The rebuilt surface was built beside this address at /v1 so the page in use was never the page
    being changed. It is the only surface now.
    """
    if k and hmac.compare_digest(k, TOKEN):
        # A fresh, revocable session per sign-in rather than the master token in the cookie, so a
        # leaked cookie or a URL in a log can be withdrawn by deleting one line. A browser that already
        # holds one of those sessions keeps it: minting on every visit grew the device list by a line a
        # page load, which is not a session count any more, it is a leak.
        held = cookie_token(request)
        if held and (held in device_tokens() or hmac.compare_digest(held, TOKEN)):
            return RedirectResponse("/", status_code=302)     # already signed in on this browser
        tok = add_device(pair_label(request), "full")
        r = RedirectResponse("/", status_code=302)
        r.set_cookie(COOKIE, tok, max_age=COOKIE_MAX_AGE, httponly=True, secure=True, samesite="lax")
        return r
    if not authed(request):
        return gate(ua=request.headers.get("user-agent", ""))
    return console_page()


# --- the door: one code, sent to him, to sign a device in ---------------------------------------------
# What stood here was a master key in a URL. A URL is copied into histories, logs and screenshots, and
# the key never expires; a code that is sent to his own channel is a thing only he can complete. The
# keyed address and the pairing code stay, as the way back in if the door itself is ever the problem.

DOOR_OTP = os.path.join(HERMES, "jarvis_live_otp.json")
DOOR_TTL = 600                     # a code is good for ten minutes
DOOR_TRIES = 5                     # and for five wrong guesses
DOOR_RATE = {}                     # ip -> [(when, what)], trimmed on each use
_HERMES_BIN = ""                   # resolved once, see _hermes_bin()
_DOOR_LOCK = threading.Lock()


def _admin_jid():
    """The owner's own channel, which is where a code goes."""
    try:
        with open(os.path.join(HERMES, "config.yaml"), encoding="utf-8") as f:
            for line in f:
                if "allow_admin_from:" in line:
                    for item in line.split(":", 1)[1].split(","):
                        item = item.strip()
                        if item.endswith("@lid") or item.endswith("@s.whatsapp.net"):
                            return "whatsapp:" + item
    except Exception:
        pass
    return ""


def _door_allowed(ip, what, limit, window):
    """A blunt rate limit: the door is public, and sending codes is a way to spend someone else's day."""
    now = time.time()
    with _DOOR_LOCK:
        hits = [t for t in DOOR_RATE.get((ip, what), []) if now - t < window]
        if len(hits) >= limit:
            DOOR_RATE[(ip, what)] = hits
            return False
        hits.append(now)
        DOOR_RATE[(ip, what)] = hits
        return True


def _door_read():
    try:
        with open(DOOR_OTP, encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def _door_write(d):
    tmp = DOOR_OTP + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f)
    os.replace(tmp, DOOR_OTP)


def _door_hash(code, salt):
    return hashlib.sha256((str(salt) + ":" + str(code)).encode()).hexdigest()


def _hermes_bin():
    """The hermes executable, found by hand.

    A user systemd unit gets PATH=/usr/local/sbin:...:/snap/bin and nothing of the user's, so a bare
    "hermes" subprocess raises FileNotFoundError and every code fails to send -- which is exactly what the
    owner saw. Resolve it once, prefer PATH when a shell really has it, and hand the child a PATH that
    contains the same directory so anything it spawns also resolves.
    """
    global _HERMES_BIN
    if _HERMES_BIN:
        return _HERMES_BIN
    cands = [shutil.which("hermes"),
             os.path.expanduser("~/.local/bin/hermes"),
             "/home/ubuntu/.local/bin/hermes",
             os.path.expanduser("~/.hermes/hermes-agent/venv/bin/hermes"),
             os.path.expanduser("~/.hermes/hermes-agent/venv/bin/hermes-cli")]
    for c in cands:
        if c and os.path.exists(c) and os.access(c, os.X_OK):
            _HERMES_BIN = c
            print("door: mail will use %s" % c)
            return c
    print("door: no hermes executable found; codes cannot be sent")
    return ""


def _mail_to(address, subject, body):
    """Send one message to an address, over the node's own mail channel."""
    exe = _hermes_bin()
    if not exe:
        return False
    env = dict(os.environ)
    env["HOME"] = os.path.expanduser("~")
    env["PATH"] = os.path.dirname(exe) + ":" + env.get("PATH", "/usr/local/bin:/usr/bin:/bin")
    for target in ("email:" + address, "email"):
        try:
            r = subprocess.run([exe, "send", "-t", target, "-s", subject, body],
                               capture_output=True, text=True, timeout=45, env=env)
            if r.returncode == 0:
                return True
            print("door: send via %s failed rc=%s %s" % (target, r.returncode, (r.stderr or "")[:200]))
        except Exception as e:
            print("door: send via %s raised %r" % (target, e))
    return False


def door_send_code(email):
    """Mint a code for one account and mail it to that account's own address.

    The answer is the same whether or not the address has an account: which addresses exist here is not
    something a stranger gets to learn from the sign-in page.
    """
    email = (email or "").strip().lower()
    if not email or "@" not in email:
        return False, "That does not look like an address."
    acct = account_for(email)
    if not acct:
        return True, "If that address has an account, a code is on its way."
    code = "%06d" % secrets.randbelow(1000000)
    salt = secrets.token_hex(8)
    d = _door_read()
    d[email] = {"h": _door_hash(code, salt), "salt": salt, "exp": time.time() + DOOR_TTL, "tries": 0}
    _door_write(d)
    body = ("Your JARVIS sign-in code is %s\n\n"
            "It is good for ten minutes, once, on one device. "
            "If you did not ask to sign in, ignore this message and nothing happens." % code)
    if not _mail_to(email, "JARVIS sign-in code", body):
        return False, "The code could not be sent just now."
    print("door: sign-in code mailed to %s" % email)
    return True, "If that address has an account, a code is on its way."


def door_verify(email, code, ua):
    """Check a code and, when it is right, hand back a device token for this client."""
    email = (email or "").strip().lower()
    code = re.sub(r"\D", "", str(code or ""))
    d = _door_read()
    rec = d.get(email)
    if not rec:
        return None, "Ask for a code first."
    if time.time() > float(rec.get("exp") or 0):
        d.pop(email, None)
        _door_write(d)
        return None, "That code has expired. Ask for a new one."
    rec["tries"] = int(rec.get("tries") or 0) + 1
    if rec["tries"] > DOOR_TRIES:
        d.pop(email, None)
        _door_write(d)
        return None, "Too many tries. Ask for a new code."
    if not hmac.compare_digest(_door_hash(code, rec.get("salt")), rec.get("h") or ""):
        _door_write(d)
        return None, "That code is not right."
    d.pop(email, None)                      # one shot, spent
    _door_write(d)
    return add_device(pair_label_ua(ua), "full"), "ok"


def pair_label_ua(ua):
    """The device key for a client signing in -- the same key devices_summary groups by."""
    return device_key_for(ua)


def google_state_new(client=""):
    """One pending sign-in, remembered on the node rather than in a cookie.

    The state used to be checked against a cookie, and a browser that did not carry it back from Google
    was refused before Google was even called, which is what the owner hit. The node knows which states it
    issued; that is the authority. Each is single use, good for fifteen minutes, and records whether the
    flow started inside the installed app, because an app cannot receive a cookie set out in a browser.
    """
    st = secrets.token_urlsafe(16)
    d = _door_read()
    now = time.time()
    g = {}
    for k, v in (d.get("_gstates") or {}).items():
        exp = (v or {}).get("exp") if isinstance(v, dict) else v
        if float(exp or 0) > now:
            g[k] = v
    g[st] = {"exp": now + 900, "client": str(client or "")}
    d["_gstates"] = g
    _door_write(d)
    return st


def google_state_take(st):
    """Spend a state, if this node issued it and it has not expired. Returns its record."""
    st = str(st or "")
    if not st:
        return None
    d = _door_read()
    g = d.get("_gstates") or {}
    rec = g.get(st)
    if not isinstance(rec, dict) or float(rec.get("exp") or 0) <= time.time():
        return None
    g.pop(st, None)
    d["_gstates"] = g
    _door_write(d)
    return rec


def app_code_new():
    """A one-time code that hands a sign-in completed in a browser to the app that asked for it."""
    code = secrets.token_urlsafe(24)
    d = _door_read()
    d["_appcode:" + code] = {"exp": time.time() + 180}
    _door_write(d)
    return code


def app_code_take(code):
    d = _door_read()
    rec = d.pop("_appcode:" + str(code or ""), None)
    _door_write(d)
    return bool(rec) and float((rec or {}).get("exp") or 0) > time.time()


def google_web_client(path=None):
    """The web OAuth client, when one has been configured for this host.

    The Google credential already on this node is an installed (desktop) client: Google only lets those
    redirect to localhost, so it cannot sign anyone in through a public address. A Web-application client
    with this host's callback registered is what the door needs, and creating one is the owner's action.

    Both shapes are accepted: the file the console lets you download wraps everything under "web", and a
    hand-written file may be flat. A missing redirect_uri falls back to this node's own callback.
    """
    d = _load_json(path or GOOGLE_WEB_FILE, None)
    if not isinstance(d, dict):
        return None
    w = d.get("web") if isinstance(d.get("web"), dict) else d
    cid, sec = w.get("client_id"), w.get("client_secret")
    if not cid or not sec:
        return None
    red = ""
    uris = w.get("redirect_uris")
    if isinstance(uris, list) and uris:
        red = str(uris[0])
    return {"client_id": cid, "client_secret": sec,
            "redirect_uri": red or "https://live.battemohammad.com/auth/google/callback"}



def _bounce(to, token=None, ttl=2592000):
    """Land the browser on the page it should be on, without leaving the sign-in in its history.

    A plain redirect leaves the callback in the back stack, so pressing back walks into Google's consent
    screen again, which is exactly what happened to him. Replacing the location keeps one entry.
    """
    r = HTMLResponse('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                     '<body style="background:#08090b;margin:0"><script>location.replace(%s)</script></body>'
                     % json.dumps(str(to)))
    if token:
        r.set_cookie(COOKIE, token, max_age=ttl, httponly=True, secure=True, samesite="lax")
    return r

def door_page(message="", email="", step="email", ua=""):
    """The sign-in screen. Two buttons: the code, and Google. Nothing else to press."""
    from html import escape
    g = google_web_client()
    embedded = bool(re.search(r"(Capacitor|; wv\)|JARVISLive)", str(ua or "")))
    if g:
        google_row = ('<button id="g" class="google"><span class="gmk">G</span> Continue with Google</button>')
        if embedded:
            google_row += ('<div class="note">In the app, use the code. Google opens your browser and the '
                           'sign-in stays there, not in the app.</div>')
    else:
        google_row = ('<div class="note">Google sign-in is not wired yet: it needs an OAuth client of type '
                      '<em>Web application</em> with this address as its redirect URI.</div>')
    return HTMLResponse("""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#08090b"><title>Sign in \u00b7 JARVIS</title>
<style>
 *{box-sizing:border-box} html,body{margin:0;min-height:100%%}
 body{background:#08090b;color:#e8e8ea;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      display:flex;align-items:center;justify-content:center;padding:28px}
 .card{width:100%%;max-width:370px}
 .dot{width:54px;height:54px;border-radius:50%%;border:1px solid #2a2c31;display:grid;place-items:center;margin:0 auto 20px}
 .dot i{width:18px;height:18px;border-radius:50%%;background:#e8b04b;display:block}
 h1{font-size:18px;font-weight:600;text-align:center;margin:0 0 6px}
 .sub{color:#8d9096;font-size:13.5px;text-align:center;margin:0 0 24px}
 label{display:block;font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;color:#8d9096;margin:16px 0 6px}
 input{width:100%%;padding:13px 14px;border-radius:12px;border:1px solid #24262b;background:#0e1013;color:#e8e8ea;
       font:inherit;font-size:16px}
 input:focus{outline:none;border-color:#3a3d44}
 button{width:100%%;margin-top:16px;padding:14px;border-radius:12px;border:0;background:#e8b04b;color:#141414;
        font:inherit;font-weight:600;cursor:pointer}
 button.google{background:#141518;color:#e8e8ea;border:1px solid #24262b;font-weight:500;
   display:flex;align-items:center;justify-content:center;gap:10px}
 .gmk{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%%;background:#fff;color:#141414;
   font-size:12px;font-weight:700}
 .msg{color:#e8b04b;font-size:13.5px;text-align:center;margin-top:16px;min-height:18px}
 .note{color:#7c7f85;font-size:12px;line-height:1.5;margin-top:16px;padding:12px;border:1px solid #1c1e22;border-radius:10px}
 .foot{color:#5f6266;font-size:11.5px;text-align:center;margin-top:22px;line-height:1.6}
 .foot a{color:#8d9096}
 #step2{display:none}
</style></head>
<body><div class="card">
 <div class="dot"><i></i></div>
 <h1>Sign in</h1>
 <div class="sub">One account. A code goes to its address.</div>
 <label for="email">Email</label>
 <input id="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" value="%s">
 <div id="step2">
   <label for="code">Code</label>
   <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" maxlength="6">
 </div>
 <button id="go">Email me a code</button>
 %s
 <div class="msg" id="msg">%s</div>
 <div class="foot">Sign-up is closed: this node serves the owner's account.<br>
   Already paired? <a href="/pair-screen">Use a pairing code</a>.</div>
</div>
<script>
 const E=document.getElementById('email'), C=document.getElementById('code'), M=document.getElementById('msg'),
       S2=document.getElementById('step2'), G=document.getElementById('go'), IN_APP=%s;
 let asked=false;
 async function post(u,b){ try{ const r=await fetch(u,{method:'POST',credentials:'same-origin',
   headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); return await r.json(); }
   catch(e){ return {ok:false,error:'No answer from the node.'}; } }
 async function askForCode(){
   if(!E.value.trim()){ M.textContent='Enter your address first.'; E.focus(); return false; }
   M.textContent='Sending\u2026';
   const j=await post('/door/code',{email:E.value});
   M.textContent=(j&&j.message)||'Could not send.';
   return !!(j&&j.ok);
 }
 G.onclick=async()=>{
   // One button, two steps: the first press sends the code and relabels itself; the second signs in.
   if(!asked){ if(await askForCode()){ asked=true; S2.style.display='block'; G.textContent='Sign in'; C.focus(); } return; }
   if(!C.value.trim()){ M.textContent='Enter the code from your email.'; C.focus(); return; }
   M.textContent='Checking\u2026';
   const j=await post('/door/verify',{email:E.value,code:C.value});
   if(j&&j.ok){ location.replace('/'); return; }
   M.textContent=(j&&j.error)||'That did not work.';
 };
 C.addEventListener('keydown',e=>{ if(e.key==='Enter') G.click(); });
 E.addEventListener('keydown',e=>{ if(e.key==='Enter') G.click(); });
 const GB=document.getElementById('g');
 if(GB) GB.onclick=()=>{ location.href='/auth/google' + (IN_APP ? '?client=app' : ''); };
</script>
</body></html>""" % (escape(email, quote=True), google_row, escape(message), "true" if embedded else "false"))


@app.get("/auth/google")
def auth_google(request: Request, force: int = 0, client: str = ""):
    """Send the browser to Google.

    Silent first. Asking Google for the account chooser on every sign-in is why he was asked to share his
    name and address again and again: with prompt=none Google answers from the grant it already holds and
    only asks when it genuinely has to. force=1 is the interactive retry, used when the silent attempt
    comes back needing a human (a first sign-in on this client, or a withdrawn grant).
    """
    g = google_web_client()
    if not g:
        return door_page(message="Google sign-in needs a Web-application OAuth client first.")
    state = google_state_new("app" if client == "app" else "")
    params = {"client_id": g["client_id"], "redirect_uri": g["redirect_uri"], "response_type": "code",
              "scope": "openid email profile", "state": state, "include_granted_scopes": "true"}
    if not force:
        params["prompt"] = "none"                    # silent when the grant is already there
    q = urllib.parse.urlencode(params)
    r = RedirectResponse("https://accounts.google.com/o/oauth2/v2/auth?" + q, status_code=302)
    r.set_cookie("jlg", state, max_age=600, httponly=True, secure=True, samesite="lax")
    return r


@app.get("/auth/google/callback")
def auth_google_cb(request: Request):
    """Come back from Google, and sign in only an address that already has an account here."""
    g = google_web_client()
    if not g:
        return door_page(message="Google sign-in is not configured.")
    q = dict(request.query_params)
    rec = google_state_take(q.get("state"))
    if not rec:
        print("google callback: unrecognised state")
        return door_page(message="That sign-in could not be verified. Try again.")
    err = str(q.get("error") or "")
    if err in ("login_required", "interaction_required", "consent_required", "account_selection_required"):
        return RedirectResponse("/auth/google?force=1" + ("&client=app" if rec.get("client") == "app" else ""),
                                status_code=302)                      # ask a human, once
    if err:
        print("google callback: google said %s" % err)
        return door_page(message="Google refused the sign-in: " + err.replace("_", " ") + ".")
    if not q.get("code"):
        return door_page(message="Google did not return a code.")
    try:
        body = urllib.parse.urlencode({"code": q["code"], "client_id": g["client_id"],
                                       "client_secret": g["client_secret"],
                                       "redirect_uri": g["redirect_uri"],
                                       "grant_type": "authorization_code"}).encode()
        req = urllib.request.Request("https://oauth2.googleapis.com/token", data=body,
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        tok = json.loads(urllib.request.urlopen(req, timeout=20).read().decode())
        req2 = urllib.request.Request("https://www.googleapis.com/oauth2/v3/userinfo",
                                      headers={"Authorization": "Bearer " + tok.get("access_token", "")})
        who = json.loads(urllib.request.urlopen(req2, timeout=20).read().decode())
    except Exception as e:
        detail = ""
        try:
            detail = e.read().decode()[:300] if hasattr(e, "read") else ""
        except Exception:
            pass
        print("google sign-in failed: %r %s" % (e, detail))
        return door_page(message="Google refused the sign-in.")
    email = str(who.get("email") or "").lower()
    if not who.get("email_verified") or not account_for(email):
        return door_page(message="That Google account has no account here, and sign-up is closed.")
    ses = add_device(device_key_for(request.headers.get("user-agent", "")), "full")
    print("sign-in: google, %s%s" % (email, " (app)" if rec.get("client") == "app" else ""))
    if rec.get("client") == "app":
        # An app's own webview never sees a cookie set out in a browser, so the sign-in is handed back as
        # a one-time code: the app opens /app/session with it and the session is minted where it is needed.
        return RedirectResponse("jarvislive://auth?code=" + app_code_new(), status_code=302)
    return _bounce("/", ses)


@app.get("/app/session")
def app_session(request: Request, code: str = ""):
    """Where the app lands after Google: a one-time code becomes a session inside the app's own webview."""
    if not app_code_take(code):
        return RedirectResponse("/door", status_code=302)
    ses = add_device(device_key_for(request.headers.get("user-agent", "")), "full")
    print("app session minted from a handed-back code")
    return _bounce("/", ses)



@app.get("/door", response_class=HTMLResponse)
def door_get(request: Request):
    if authed(request):
        return RedirectResponse("/", status_code=302)
    return door_page()


@app.post("/door/code")
async def door_code(request: Request):
    ip = client_ip(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    email = str((body or {}).get("email") or "").strip().lower()
    # Two buckets: the address that asked, and the address it was asked for. The second one is what
    # keeps a crowd of IPs from spending one person's inbox; the first keeps one IP from spending many.
    allowed_ip = _door_allowed(ip, "send", 3, 900)
    allowed_email = _door_allowed("email:" + email, "send", 3, 900) if "@" in email else True
    if not allowed_ip or not allowed_email:
        return JSONResponse({"ok": False, "error": "Too many codes asked for. Try again in a few minutes."},
                            status_code=429)
    ok, msg = door_send_code(email)
    return JSONResponse({"ok": bool(ok), "message": msg}, status_code=200 if ok else 400)


@app.post("/door/verify")
async def door_verify_ep(request: Request):
    ip = client_ip(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    email = str((body or {}).get("email") or "").strip().lower()
    allowed_ip = _door_allowed(ip, "verify", 12, 900)
    allowed_email = _door_allowed("email:" + email, "verify", 12, 900) if "@" in email else True
    if not allowed_ip or not allowed_email:
        return JSONResponse({"ok": False, "error": "Too many tries. Wait a few minutes."}, status_code=429)
    tok, why = door_verify(email, (body or {}).get("code"),
                           request.headers.get("user-agent", ""))
    if not tok:
        return JSONResponse({"ok": False, "error": why}, status_code=400)
    r = JSONResponse({"ok": True})
    r.set_cookie(COOKIE, tok, max_age=COOKIE_MAX_AGE, httponly=True, secure=True, samesite="lax")
    return r


@app.get("/v1", response_class=HTMLResponse)
def index_v1(request: Request):
    """The same page as the root, kept as an address.

    It was the rebuilt surface's own route while the old page still held /. Now that it holds /
    too, this stays so that links already given out — a bookmark, a home-screen icon — keep
    working instead of becoming a redirect chain.
    """
    if not authed(request):
        return gate(ua=request.headers.get("user-agent", ""))
    return console_page()


@app.get("/sw.js")
def service_worker():
    """The offline shell. Served from the root so its scope is the whole page, and never cached for
    long: a stale service worker is a page that cannot be fixed by deploying."""
    path = os.path.join(HERE, "static", "sw.js")
    if not os.path.exists(path):
        return JSONResponse({"error": "no worker"}, status_code=404)
    return FileResponse(path, media_type="application/javascript",
                        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"})


@app.get("/cue/{name}")
def cue(name: str):
    """Short spoken lines for the moments when there is nothing else to say: he spoke and was
    not understood, or the transcriber could not be reached. Left silent, a failed capture is
    indistinguishable from being ignored, which is how it read to him.

    Public on purpose: it is audio, not data, and it must play even when the cookie is odd.
    """
    if not re.fullmatch(r"[a-z]{3,20}", name or ""):
        return JSONResponse({"error": "no such cue"}, status_code=404)
    path = os.path.join(HERE, "cues", name + ".mp3")
    if not os.path.exists(path):
        return JSONResponse({"error": "no such cue"}, status_code=404)
    return FileResponse(path, media_type="audio/mpeg",
                        headers={"Cache-Control": "public, max-age=86400"})


# "widget" carries a URL on the widget origin and is framed by the page, not merely linked: the
# frame is what lets a widget speak back, so a tap inside it can put a question to JARVIS. The
# page has rendered this kind all along; leaving it out of this list was the only thing keeping an
# interactive panel off the screen.
# "video" carries a YouTube embed, normalised here so only a video id can ever reach the frame.
# "chart" is the page's own hand-drawn bar or line, the same one an answer can carry inline. It was
# missing from this list, which is why a pushed graph was refused as an unknown kind while the page
# had the renderer all along. Shape: {kind:"chart", chart:"bar"|"line", data:[[label, value], ...],
# unit, source}. The chart's own shape travels in `chart` because `kind` already names the artifact.
ART_KINDS = ("text", "table", "list", "code", "metrics", "chart", "image", "link", "widget", "video",
             "clear")
ART_MAX_BYTES = 400000

# A video is only ever a YouTube id. The id is taken out of whatever shape the link arrives in and
# the embed address is built here, so a payload cannot smuggle an arbitrary page into the frame.
YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
YT_IN_URL = re.compile(r"(?:youtu\.be/|v=|/embed/|/shorts/|/live/|/v/)([A-Za-z0-9_-]{11})")
YT_HOSTS = frozenset((
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "youtu.be", "www.youtu.be",
    "youtube-nocookie.com", "www.youtube-nocookie.com",
))


def youtube_id(text: str) -> str:
    """The 11-character video id from a watch link, a short link, or the bare id.

    A link is only read if its host is really YouTube, so a link that merely carries a video id in
    its query string cannot be turned into an embed.
    """
    t = (text or "").strip()
    if YT_ID.match(t):
        return t
    try:
        host = (urllib.parse.urlsplit(t if "//" in t else "https://" + t).hostname or "").lower()
    except ValueError:
        return ""
    if host not in YT_HOSTS:
        return ""
    m = YT_IN_URL.search(t)
    return m.group(1) if m else ""


def art_token_ok(request: Request) -> bool:
    """The console token in a header, which is how a local tool speaks to the page.

    A page running on another site cannot set a header without a preflight first, so a correct
    header needs no origin check; the cookie path below keeps the same-origin rule the rest of the
    console uses.
    """
    got = request.headers.get("x-jarvis-token", "")
    return bool(got) and hmac.compare_digest(got, TOKEN)


@app.get("/screen/last")
def screen_last(request: Request):
    """What is up there, so a tab that was asleep or has just reloaded can catch up.

    Without this a panel sent while the phone was locked simply never appeared, and there was no
    way to tell that from a panel that was never sent.
    """
    if auth_scope(request) is None:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    if not same_origin(request):
        return JSONResponse({"error": "cross-site"}, status_code=403)
    return {"ok": True, "art": LAST_ART["payload"]}


@app.get("/screen")
async def screen_channel(request: Request):
    """The page's standing channel, open for the life of the tab.

    Only one thing travels on it: a typed artifact, put there by anything holding the console
    token. Before this, the only way anything reached the screen was a turn the page itself had
    started, so the agent could describe a table but could never show one.
    """
    if auth_scope(request) is None:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    if not same_origin(request):
        return JSONResponse({"error": "cross-site"}, status_code=403)

    with SCREENS_LOCK:
        SCREEN_SEQ[0] += 1
        sid = "s%d" % SCREEN_SEQ[0]

    async def gen():
        loop = asyncio.get_running_loop()
        q = asyncio.Queue(maxsize=8)          # small: a screen that stops taking is a dead screen
        with SCREENS_LOCK:
            SCREENS[sid] = (loop, q)
        try:
            yield ": open\n\n"
            while True:
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    # A tab that has been closed says so here, and this is the only place that
                    # notices: a write into a dead connection can succeed silently, so the count
                    # the agent is given would otherwise include screens nobody is looking at.
                    if await request.is_disconnected():
                        break
                    yield ": ping\n\n"
                    continue
                if await request.is_disconnected():
                    break
                yield sse("art", payload)
        finally:
            with SCREENS_LOCK:
                SCREENS.pop(sid, None)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform",
                                      "X-Accel-Buffering": "no", "Connection": "keep-alive"})


@app.post("/art")
async def art(request: Request):
    """Put one typed artifact on every open screen. Says how many screens took it."""
    if not (art_token_ok(request) or
            (auth_scope(request) == "master" and same_origin(request))):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    raw = await request.body()
    if len(raw) > ART_MAX_BYTES:
        return JSONResponse({"error": "artifact too large"}, status_code=413)
    try:
        payload: dict = json.loads(raw or b"{}")
    except Exception:
        return JSONResponse({"error": "malformed body"}, status_code=400)
    if not isinstance(payload, dict):
        return JSONResponse({"error": "malformed body"}, status_code=400)
    if not RESPONSE_AUTHORING.SOURCES.artifact_allowed(payload):
        return JSONResponse({"error": "A screen artifact requires an active voice-turn publication grant; text answers publish inline."}, status_code=409)
    payload.pop('publication', None)
    if payload.get("clear"):
        payload = {"kind": "clear"}
    kind = str(payload.get("kind") or "")
    if kind not in ART_KINDS:
        # Refused loudly rather than rendered as nothing: a tool that lies about success is worse
        # than one that fails.
        return JSONResponse({"error": "unknown kind", "known": list(ART_KINDS)}, status_code=400)
    if kind == "video":
        vid = youtube_id(str(payload.get("src") or payload.get("href") or payload.get("url") or ""))
        if not vid:
            return JSONResponse(
                {"error": "not a YouTube video",
                 "hint": "send a watch link, a youtu.be link, or the 11-character video id"},
                status_code=400)
        payload = dict(payload)
        payload["src"] = "https://www.youtube-nocookie.com/embed/" + vid
        payload["watch"] = "https://www.youtube.com/watch?v=" + vid
    # B2: a sequence number is stamped on every panel. Two identical tables are two panels, not a
    # replay, and the page can show the second one after the first was cleared.
    ART_SEQ[0] += 1
    payload = dict(payload)
    payload["seq"] = ART_SEQ[0]
    sent = broadcast_art(payload)
    print("artifact %s -> %d screen(s)" % (kind, sent))
    return {"ok": True, "screens": sent, "kind": kind}


# ---------------------------------------------------------------- images (Phase 2)
# Two separate jobs, deliberately: FINDING an image and DRAWING one. The renderer draws; this block
# finds and fetches. The model never invents a URL: it either quotes one it actually read, or it
# writes a search phrase and the page asks here.
#
# Why a proxy at all. A remote <img> is a request from his phone to a stranger's server: it discloses
# his address, his provider, roughly where he is and that he is looking at that picture, and it lets
# whoever runs it count him. Every image is therefore fetched by this machine and handed to the page
# from the same origin, with no referrer and no cookie.
IMG_CACHE = os.path.join(HERE, ".imgcache")
IMG_MAX_BYTES = 5 * 1024 * 1024
IMG_MAX_FILES = 400
IMG_TTL = 7 * 86400
IMG_UA = "JARVIS-Live/1.0 (personal assistant; image rendering)"
IMG_PORTS = (443, 80)


def _img_host_ok(url: str) -> bool:
    """True only for an https URL whose host resolves entirely to public addresses.

    The proxy runs on his own machine, so a URL pointing at the loopback interface or at a private
    range is not a picture, it is a way to make this server talk to something it should not: a router
    admin page, a cloud metadata endpoint, a service on 127.0.0.1. Every address the name resolves to
    must be public before the request is made.
    """
    try:
        u = urllib.parse.urlsplit(url)
    except Exception:
        return False
    if u.scheme != "https" or not u.hostname:
        return False
    if u.username or u.password:          # credentials in a URL are never a picture
        return False
    try:
        port = u.port or 443
    except Exception:
        return False
    if port not in IMG_PORTS:
        return False
    host = u.hostname.strip("[]")
    if host in ("localhost",) or host.endswith(".local") or host.endswith(".internal"):
        return False
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except Exception:
        return False
    if not infos:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except Exception:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
                or ip.is_multicast or ip.is_unspecified):
            return False
    return True


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to an address that would have been allowed in the first place."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _img_host_ok(newurl):
            raise urllib.error.HTTPError(newurl, code, "redirect refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_IMG_OPENER = urllib.request.build_opener(_SafeRedirect())


def _img_cache_get(key: str):
    """The cached bytes for a key, or None when absent or older than the retention."""
    p = os.path.join(IMG_CACHE, key + ".bin")
    m = os.path.join(IMG_CACHE, key + ".json")
    try:
        if time.time() - os.path.getmtime(p) > IMG_TTL:
            return None
        meta = json.loads(open(m, encoding="utf-8").read())
        return open(p, "rb").read(), meta.get("type") or "image/jpeg"
    except Exception:
        return None


def _img_cache_put(key: str, body: bytes, ctype: str):
    try:
        os.makedirs(IMG_CACHE, exist_ok=True)
        with open(os.path.join(IMG_CACHE, key + ".bin"), "wb") as f:
            f.write(body)
        with open(os.path.join(IMG_CACHE, key + ".json"), "w", encoding="utf-8") as f:
            json.dump({"type": ctype, "at": int(time.time())}, f)
        files = glob.glob(os.path.join(IMG_CACHE, "*.bin"))
        if len(files) > IMG_MAX_FILES:
            files.sort(key=os.path.getmtime)
            for old in files[: len(files) - IMG_MAX_FILES]:
                try:
                    os.unlink(old)
                    os.unlink(old[:-4] + ".json")
                except Exception:
                    pass
    except Exception:
        pass


def _img_fetch(url: str):
    """(bytes, content-type) for an allowed URL, or raises. Follows at most three safe hops."""
    if not _img_host_ok(url):
        raise ValueError("address refused")
    req = urllib.request.Request(url, headers={"User-Agent": IMG_UA, "Accept": "image/*"})
    with _IMG_OPENER.open(req, timeout=10) as r:
        ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if not ctype.startswith("image/"):
            raise ValueError("not an image")
        stated = r.headers.get("Content-Length")
        if stated and str(stated).isdigit() and int(stated) > IMG_MAX_BYTES:
            raise ValueError("too large")
        body = r.read(IMG_MAX_BYTES + 1)
    if len(body) > IMG_MAX_BYTES:
        raise ValueError("too large")
    if not body:
        raise ValueError("empty")
    return body, ctype


@app.get("/img")
def img_proxy(request: Request, u: str = ""):
    """One image, fetched here and served from this origin. Never a redirect to somewhere else."""
    if not _guard(request):
        return JSONResponse({"error": "refused"}, status_code=403)
    if not u or len(u) > 2000:
        return JSONResponse({"error": "bad url"}, status_code=400)
    key = hashlib.sha256(u.encode("utf-8")).hexdigest()[:40]
    got = _img_cache_get(key)
    if got:
        body, ctype = got
    else:
        try:
            body, ctype = _img_fetch(u)
        except Exception:
            # A missing picture must not look like a broken page: the page draws its own fallback,
            # and this says plainly that the fetch failed rather than serving a placeholder as art.
            return JSONResponse({"error": "unavailable"}, status_code=404)
        _img_cache_put(key, body, ctype)
    return Response(content=body, media_type=ctype, headers={
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    })


def _img_proxied(url: str) -> str:
    return "/img?u=" + urllib.parse.quote(url, safe="")


def _img_search_openverse(q: str, n: int):
    """Licensed images from Openverse. Every result carries its creator and its licence."""
    url = ("https://api.openverse.org/v1/images/?q=" + urllib.parse.quote(q)
           + "&page_size=%d&license_type=all-cc&mature=false" % max(n * 3, 6))
    req = urllib.request.Request(url, headers={"User-Agent": IMG_UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        doc = json.loads(r.read(300000).decode("utf-8", "replace"))
    out = []
    for x in (doc.get("results") or []):
        src = str(x.get("url") or "")
        if not src.startswith("https://"):
            continue
        out.append({
            "origin": src,
            "thumb": _img_proxied(src),
            "title": (str(x.get("title") or "") or "Untitled")[:90],
            "creator": str(x.get("creator") or "")[:60],
            "license": str(x.get("license") or "").upper(),
            "license_url": str(x.get("license_url") or ""),
            "page": str(x.get("foreign_landing_url") or ""),
        })
    return out


def _img_search_commons(q: str, n: int):
    """Wikimedia Commons, the second source: freely licensed, with the author named."""
    url = ("https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search"
           "&gsrsearch=" + urllib.parse.quote("filetype:bitmap " + q) + "&gsrlimit=%d&gsrnamespace=6"
           "&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1200" % max(n, 4))
    req = urllib.request.Request(url, headers={"User-Agent": IMG_UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        doc = json.loads(r.read(300000).decode("utf-8", "replace"))
    pages = ((doc.get("query") or {}).get("pages") or {})
    out = []
    for v in pages.values():
        ii = (v.get("imageinfo") or [{}])[0]
        src = str(ii.get("thumburl") or ii.get("url") or "")
        if not src.startswith("https://"):
            continue
        md = ii.get("extmetadata") or {}
        artist = re.sub(r"<[^>]+>", "", str((md.get("Artist") or {}).get("value") or ""))[:60]
        out.append({
            "origin": src,
            "thumb": _img_proxied(src),
            "title": str(v.get("title") or "").replace("File:", "")[:90],
            "creator": re.sub(r"\s+", " ", artist).strip(),
            "license": str((md.get("LicenseShortName") or {}).get("value") or "")[:24],
            "license_url": "https://commons.wikimedia.org/wiki/Commons:Licensing",
            "page": "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(str(v.get("title") or "")),
            "w": ii.get("thumbwidth") or ii.get("width"),
            "h": ii.get("thumbheight") or ii.get("height"),
        })
    return out


@app.get("/img/search")
def img_search(request: Request, q: str = "", n: int = 4):
    """Find a picture for a phrase. Returns nothing rather than a guess when nothing is found."""
    if not _guard(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    q = str(q or "").strip()[:120]
    n = max(1, min(int(n or 4), 6))
    if not q:
        return JSONResponse({"ok": True, "images": [], "origin": ""})
    for name, fn in (("openverse", _img_search_openverse), ("commons", _img_search_commons)):
        try:
            found = fn(q, n)
        except Exception as e:
            print("image search %s failed: %r" % (name, e))
            found = []
        seen, keep = set(), []
        for it in found:
            if it["origin"] in seen:
                continue
            seen.add(it["origin"])
            keep.append(it)
            if len(keep) >= n:
                break
        if keep:
            return JSONResponse({"ok": True, "images": keep, "origin": name, "q": q})
    return JSONResponse({"ok": True, "images": [], "origin": ""})


# ---------------------------------------------------------------- attachments (item 1)
# A staged file for the next turn. The page carries no multipart dependency (python-multipart is
# not in this venv), so the bytes arrive as the raw body with the file's own name in the query
# string, and nothing has to be parsed by hand. The file is written under uploads/<day>/ and its
# path is handed back: the page puts that path into the question, so the agent reads it with its
# own file tools instead of the page inventing a channel that does not exist.
ATTACH_DIR = os.path.join(HERE, "uploads")
ATTACH_MAX = 50 * 1024 * 1024          # a phone can hand over a document, a photo or a clip
ATTACH_KEEP_DAYS = 7

# Every kind of file is accepted, the way a messenger accepts one. What is bounded is the size and
# the rate, not the type: a file that is stored and named to the agent costs the same whether it is
# a video or a spreadsheet, and refusing a kind was the page deciding what he may send himself.


def _cull_uploads():
    """Drop day folders older than the retention. Attachments are working files, not a store."""
    try:
        cutoff = time.time() - ATTACH_KEEP_DAYS * 86400
        for name in os.listdir(ATTACH_DIR):
            p = os.path.join(ATTACH_DIR, name)
            if os.path.isdir(p) and os.path.getmtime(p) < cutoff:
                shutil.rmtree(p, ignore_errors=True)
    except Exception:
        pass



# A file the answer produced. The agent writes it into the app's own outbox and names it in the
# answer; this is the one door it comes back out of. Nothing outside that folder can be asked for:
# the route takes a bare name and resolves it inside OUTBOX, so a path in the answer cannot walk
# the machine. Downloads carry the cookie like every other screen, so a shared link is worthless.
OUTBOX = os.path.join(HERE, "outbox")
try:
    os.makedirs(OUTBOX, exist_ok=True)
except Exception:
    pass


@app.get("/file/{name}")
def outbox_file(name: str, request: Request):
    if auth_scope(request) is None:
        raise HTTPException(status_code=401, detail="unauthorized")
    safe = os.path.basename(urllib.parse.unquote(name))
    path = os.path.realpath(os.path.join(OUTBOX, safe))
    if not safe or os.path.commonpath((path, os.path.realpath(OUTBOX))) != os.path.realpath(OUTBOX) or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="no such file")
    guessed = mimetypes.guess_type(safe)[0] or "application/octet-stream"
    # What the phone can display, it displays; everything else is handed over as a download.
    inline = guessed.startswith(("image/", "audio/", "video/")) or guessed == "application/pdf" or guessed.startswith("text/")
    return FileResponse(path, media_type=guessed, filename=safe,
                        content_disposition_type="inline" if inline else "attachment",
                        headers={"Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff"})


# A link a phone can hand to something outside the browser. A blob download is invisible to Android's
# download manager and a cookie never travels to an external viewer, so both doors failed on the app:
# the card drew, the press did nothing, and the document could not be opened or saved. A ticket is a
# short-lived, unguessable name for one file in the outbox, and it works without the session cookie.
FILE_TICKETS: dict = {}
FILE_TICKET_TTL = 900


@app.post("/file/ticket")
async def file_ticket(request: Request):
    if auth_scope(request) is None or not same_origin(request):
        return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)
    try:
        body = await request.json()
    except Exception:
        body = {}
    safe = os.path.basename(urllib.parse.unquote(str((body or {}).get("name") or "")))
    path = os.path.realpath(os.path.join(OUTBOX, safe))
    if not safe or os.path.commonpath((path, os.path.realpath(OUTBOX))) != os.path.realpath(OUTBOX) or not os.path.isfile(path):
        return JSONResponse({"ok": False, "error": "no such file"}, status_code=404)
    now = time.time()
    for k in [k for k, v in FILE_TICKETS.items() if v["exp"] < now]:
        FILE_TICKETS.pop(k, None)
    tok = secrets.token_urlsafe(18)
    mode = "attachment" if str((body or {}).get("mode") or "") == "download" else "inline"
    FILE_TICKETS[tok] = {"name": safe, "exp": now + FILE_TICKET_TTL, "mode": mode}
    return JSONResponse({"ok": True, "url": "/f/" + tok, "seconds": FILE_TICKET_TTL, "mode": mode})


@app.get("/f/{tok}")
def file_by_ticket(tok: str):
    item = FILE_TICKETS.get(tok)
    if not item or item["exp"] < time.time():
        raise HTTPException(status_code=404, detail="this link has expired")
    path = os.path.realpath(os.path.join(OUTBOX, item["name"]))
    if os.path.commonpath((path, os.path.realpath(OUTBOX))) != os.path.realpath(OUTBOX) or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="no such file")
    guessed = mimetypes.guess_type(item["name"])[0] or "application/octet-stream"
    return FileResponse(path, media_type=guessed, filename=item["name"],
                        content_disposition_type=item["mode"],
                        headers={"Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff"})


@app.post("/attach")
async def attach(request: Request):
    """Stage one attached file for the next turn. Same-origin and signed in, like every other
    endpoint that costs anything."""
    if auth_scope(request) is None or not same_origin(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    if not rate_ok(request, "attach"):
        return JSONResponse({"error": "too many uploads from this device"}, status_code=429)
    raw_name = urllib.parse.unquote(request.query_params.get("name") or "file")
    name = re.sub(r"[^\w.\- ]+", "_", os.path.basename(raw_name)).strip() or "file"
    if len(name) > 120:
        name = name[:120]
    raw = await request.body()
    if not raw:
        return JSONResponse({"error": "empty file"}, status_code=400)
    if len(raw) > ATTACH_MAX:
        return JSONResponse({"error": "file too large", "max": ATTACH_MAX}, status_code=413)
    _cull_uploads()
    folder = os.path.join(ATTACH_DIR, time.strftime("%Y%m%d"))
    try:
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, "%s-%s" % (time.strftime("%H%M%S"), name))
        with open(path, "wb") as fh:
            fh.write(raw)
    except Exception as e:
        print("attach failed: %r" % (e,))
        return JSONResponse({"error": "could not store the file"}, status_code=500)
    print("attach: %s (%d bytes)" % (os.path.basename(path), len(raw)))
    return {"ok": True, "name": name, "path": path, "bytes": len(raw)}


# ---------------------------------------------------------------- widgets (5.1)
# A widget is a capability reached by a random token on an origin of its own. The app's cookie is
# never set on that host and never accepted there, so a widget cannot act as the console even if
# its own code were hostile: the origin is the boundary, and this is where it is enforced.


def _widget_host_ok(request: Request) -> bool:
    got = (request.headers.get("host") or "").split(":")[0].lower()
    return got == WIDGETS.host().lower()


def _widget_admin(request: Request) -> bool:
    """Creating, listing and deleting a widget is an owner action: the console token in a header,
    or the master cookie from this page."""
    return bool(art_token_ok(request) or
                (auth_scope(request) == "master" and same_origin(request)))


@app.middleware("http")
async def _widget_origin_only(request: Request, call_next):
    """On the widget host, nothing but a widget and its library exists.

    The tunnel sends this hostname to the same process, so without this the console's own routes
    would answer there too and a widget origin would quietly become a way in.
    """
    if _widget_host_ok(request):
        p = request.url.path
        if not (p.startswith("/w/") or p.startswith("/lib/")):
            return JSONResponse({"error": "not found"}, status_code=404)
    return await call_next(request)


@app.post("/widget")
async def widget_create(request: Request):
    if not _widget_admin(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    if not WIDGETS.enabled():
        return JSONResponse({"error": "widgets are switched off"}, status_code=503)
    if not rate_ok(request, "widget"):
        return JSONResponse({"error": "too many widgets from this device"}, status_code=429)
    raw = await request.body()
    if len(raw) > WIDGETS.MAX_BYTES + 8192:
        return JSONResponse({"error": "widget too large"}, status_code=413)
    try:
        payload: dict = json.loads(raw or b"{}")
    except Exception:
        return JSONResponse({"error": "malformed body"}, status_code=400)
    try:
        meta = WIDGETS.create(payload.get("html"), payload.get("label", ""),
                              cookie_token(request)[:8])
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    print("widget %s -> %d bytes" % (meta["token"][:6], meta["bytes"]))
    return {"ok": True, "token": meta["token"],
            "url": "https://%s/w/%s" % (WIDGETS.host(), meta["token"]),
            "expires": meta["expires"]}


@app.get("/widgets")
def widget_list(request: Request):
    if not _widget_admin(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return {"ok": True, "widgets": [
        {"token": m["token"], "label": m.get("label", ""), "created": m.get("created"),
         "expires": m.get("expires"), "bytes": m.get("bytes"),
         "url": "https://%s/w/%s" % (WIDGETS.host(), m["token"])}
        for m in WIDGETS.list_all()]}


@app.post("/widgets/delete")
async def widget_delete(request: Request):
    if not _widget_admin(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    try:
        payload: dict = json.loads((await request.body()) or b"{}")
    except Exception:
        return JSONResponse({"error": "malformed body"}, status_code=400)
    return {"ok": WIDGETS.delete(str(payload.get("token") or ""))}


@app.get("/w/runtime/{stamp}")
def response_runtime(request: Request, stamp: str):
    if not _widget_host_ok(request) or stamp != RESPONSE_LAYER.assets()[2]:
        return JSONResponse({"error": "not found"}, status_code=404)
    if not WIDGETS.enabled():
        return JSONResponse({"error": "widgets are switched off"}, status_code=503)
    html, headers = RESPONSE_LAYER.document("https://" + PUBLIC_HOST)
    return HTMLResponse(html, headers=headers)


@app.get("/w/{token}")
def widget_serve(request: Request, token: str):
    """The widget itself. The token is the whole of the authorisation: no cookie, no session, and
    the response carries the sandbox so a direct visit is still an opaque origin."""
    if not _widget_host_ok(request):
        return JSONResponse({"error": "not found"}, status_code=404)
    if not WIDGETS.enabled():
        return JSONResponse({"error": "widgets are switched off"}, status_code=503)
    meta = WIDGETS.read_meta(token)
    if meta is None:
        return JSONResponse({"error": "no such widget"}, status_code=404)
    if WIDGETS.expired(meta):
        return JSONResponse({"error": "this widget has expired"}, status_code=410)
    doc = WIDGETS.document(token)
    if doc is None:
        return JSONResponse({"error": "no such widget"}, status_code=404)
    return HTMLResponse(doc, headers=WIDGETS.widget_headers("https://" + PUBLIC_HOST))


@app.get("/lib/{name}")
def widget_lib(request: Request, name: str):
    """The kit script and any pinned chart library, self-hosted. Never a third party."""
    if not _widget_host_ok(request):
        return JSONResponse({"error": "not found"}, status_code=404)
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,48}", name or ""):
        return JSONResponse({"error": "not found"}, status_code=404)
    path = os.path.join(WIDGETS.LIB, name)
    if not os.path.exists(path):
        return JSONResponse({"error": "not found"}, status_code=404)
    media = "application/javascript" if name.endswith(".js") else "text/css"
    return FileResponse(path, media_type=media,
                        headers={"Cache-Control": "public, max-age=31536000, immutable",
                                 "X-Content-Type-Options": "nosniff",
                                 "Referrer-Policy": "no-referrer"})


@app.post("/reset")
def reset(request: Request):
    """Start a new conversation. A bad turn used to live on in memory and reinforce itself,
    and the only cure was a restart of the service."""
    if not authed(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    if not same_origin(request):
        return JSONResponse({"error": "cross-site"}, status_code=403)
    with HISTORY_LOCK:
        hint = str(request.query_params.get("prestart") or "")
        previous_hint = getattr(WARM_PRESTART, "conv", "")
        WARM_PRESTART.conv = hint if (auth_scope(request) in ("master", "full") and re.fullmatch(r"[0-9a-f]{32}", hint)) else ""
        try:
            sid = close_session()      # keep the existing window/id/storage transition
        finally:
            WARM_PRESTART.conv = previous_hint
        # Only the window being closed loses its turns. A chat still being answered somewhere else keeps
        # working and keeps its answer: opening a new chat used to invalidate every turn in flight, which
        # is why the chat he came back to had stopped half way.
        invalidate_conv(sid)
        try:
            tmp = HISTORY_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump([], f)
            os.replace(tmp, HISTORY_FILE)
        except Exception:
            pass
    print("conversation reset: session %s" % sid[:12])
    # B3: a new conversation must take the panel down with it, on the server as well as the page,
    # or a reload brings the old turn's panel back from /screen/last.
    ART_SEQ[0] += 1
    broadcast_art({"kind": "clear", "seq": ART_SEQ[0]})
    return {"ok": True, "messages": 0, "session": sid, "started": int(time.time())}


# A pasted contract, a stack trace, a long email: 2,000 characters refused most real pastes and
# the page offered no reason. Generous, still bounded.
MAX_QUESTION = 24000


class QuietSpeaker:
    """Text mode's speaker: it does nothing, on purpose.

    He reads a typed answer; he does not want it spoken at him. The point of making it a speaker
    rather than a flag at each call site is that no call site can be missed or added later: in
    text mode no speech unit is ever submitted, so there is no synthesis call, no audio event on
    the wire, no cost, and nothing for the page's player to run against the reading eye.
    """

    def submit(self, text, kind="front"):
        return

    def close(self, timeout=None):
        return

    def abort(self):
        return


@app.get("/api/route")
async def api_route(request: Request):
    """Which shape a question would be answered in. Read-only: it lets the router be checked
    against real questions without spending a turn on each one, and it is what the page's own
    probes read."""
    if auth_scope(request) is None:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    if not same_origin(request):
        return JSONResponse({"error": "cross-site"}, status_code=403)
    q = str(request.query_params.get("q") or "")
    shape = route_format(q)
    return JSONResponse({"q": q, "shape": shape,
                         "text": format_directive(shape, "text"),
                         "voice": format_directive(shape, "voice")})


def _page_gate():
    """Page work waits for recovery. Runs once, under a cross-process lock; a failure keeps
    readiness false and returns a traceable id instead of serving the turn."""
    try:
        from page import recovery as _r
        if _r.READY["ok"]:
            return None
        res=_r.recover(PAGE_TEXT.adapter, os.path.join(HERE,"ctx","page-recovery.lock"))
        if res.get("ready"):
            return None
        reason=res.get("error_id") or "recovery_pending"
    except Exception as exc:
        reason="recovery_failed_"+type(exc).__name__
    return JSONResponse({"error":reason,"reference":reason},status_code=503)


@app.post("/api/agent/prestart/{conv}")
async def agent_prestart(conv: str, request: Request):
    _g=_page_gate()
    if _g is not None: return _g
    if auth_scope(request) not in ("master", "full"):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    if not same_origin(request):
        return JSONResponse({"ok": False, "error": "cross-site"}, status_code=403)
    if not re.fullmatch(r"[0-9a-f]{32}", conv):
        return JSONResponse({"ok": False, "error": "bad conversation"}, status_code=400)
    if tombstoned(conv):
        return JSONResponse({"ok": False, "error": "conversation was deleted"}, status_code=410)
    if not rate_ok(request, "prestart"):
        return JSONResponse({"ok": False, "error": "too many requests"}, status_code=429)
    started = False  # legacy text warming removed: only the page harness is warmed
    _page_recover_once()
    return JSONResponse({"ok": True, "started": started})


@app.post("/stream")
async def stream(request: Request):
    """One turn, by POST, same-origin only.

    The prompt used to travel in a GET query string, where it also landed in URLs and proxy logs,
    and the cookie rode any cross-site navigation. Now the question arrives in a JSON body and
    the request has to say it came from this page.
    """
    _g=_page_gate()
    if _g is not None: return _g
    scope = auth_scope(request)
    if scope is None:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    if not same_origin(request):
        return JSONResponse({"error": "cross-site"}, status_code=403)
    if not rate_ok(request, "stream"):
        return JSONResponse({"error": "too many turns from this device"}, status_code=429)
    try:
        _peek = json.loads((await request.body()) or b"{}")
        if str(_peek.get("mode") or "voice").strip().lower() == "text":
            try:
                return await PAGE_TEXT.start(request, _peek)
            except Exception:
                _id = uuid.uuid4().hex
                __import__("logging").getLogger(__name__).exception("page adapter unavailable error_id=%s", _id)
                return PAGE_TEXT.unavailable(_peek, _id)
        _pconv = str(_peek.get("conv") or "")
        if _pconv:
            warm_prewarm_for(agent_session_name(_pconv))
    except Exception:
        pass
    try:
        payload = json.loads((await request.body()) or b"{}")
    except Exception:
        return JSONResponse({"error": "malformed body"}, status_code=400)
    q = str(payload.get("q") or "").strip()
    if not q:
        return JSONResponse({"error": "empty question"}, status_code=400)
    if len(q) > MAX_QUESTION:
        return JSONResponse({"error": "question too long"}, status_code=413)
    # Which way the answer comes back. He asked for this in his own words: the page speaks only
    # when he taps the live button, and answers in text when he types. Missing means voice, so a
    # widget's question and any older client keep working exactly as they did.
    mode = str((payload or {}).get("mode") or "voice").strip().lower()
    if mode not in ("voice", "text"):
        return JSONResponse({"error": "bad mode"}, status_code=400)
    # How hard this turn should think, and whether it wants the web. Both are chosen on the page,
    # both are per-turn, and both are validated against the list this side will pass on rather than
    # trusted: a value that reaches the CLI as an argument is not a value to take on faith.
    reasoning = str((payload or {}).get("reasoning") or "").strip().lower()
    if reasoning != AUTO_REASONING and reasoning not in REASONING_LEVELS:
        reasoning = "none"
    # What the agent is told to do, once `auto` has been resolved: the same level for an explicit
    # choice, and low for the default.
    effort = AUTO_EFFORT if reasoning == AUTO_REASONING else reasoning
    _cs = chat_settings(str((payload or {}).get("conv") or "").strip() if mode == "text"
                        else str((payload or {}).get("conv") or ""))
    _web_choice = _cs["web"]
    want_web = _web_choice == "always"
    web_off = _web_choice == "off"
    # Cross-session memory is on unless the page says otherwise: a missing field keeps the behaviour
    # every older client already has, and only an explicit false turns it off for the turn.
    want_memory = _cs["memory"] != "off"

    # Minted here, not inside the worker thread (item 4a). A disconnect in the first
    # milliseconds used to bump the id before the thread minted its own, leaving the thread's id
    # current and letting a turn nobody heard commit.
    maybe_reset_idle()               # each turn: a cold window is a new conversation
    my_turn = new_turn()
    # The conversation this turn belongs to, stamped now: if the page starts a new one while this is
    # still working, the answer still belongs to the conversation he asked the question in.
    # The page names the conversation: it is the one on the screen, and it is the one that keeps the
    # answer. The server's own key is only a fallback — it is blank after a restart, which used to file a
    # turn under "current" while the page filed the same turn under its real name, splitting one answer
    # across two conversations.
    # THE turn's name: the page mints it when it asks and sends it here. That single id is what the
    # open event publishes, what the execution log carries and what the record is filed under, so the
    # page and the machine can never hold two names for one turn. A malformed or already-live id is
    # ignored and the machine mints its own, which the page then adopts from the open event.
    posted_tid = str((payload or {}).get("turn_id") or "").strip()
    if not re.fullmatch(r"[0-9a-fA-F]{8,40}", posted_tid or ""):
        posted_tid = ""
    else:
        with TURN_CHANS_LOCK:
            # Only a turn still running holds its name. A finished one keeps its name in the log so a
            # retry can be recognised as the same question; clearing the id here made every retry a
            # new turn with a new name.
            if any(str(getattr(c, "tid", "")) == posted_tid and not getattr(c, "done", True)
                   for c in TURN_CHANS.values()):
                posted_tid = ""
    posted_conv = str(payload.get("conv") or "").strip()
    if re.fullmatch(r"[0-9a-fA-F]{8,40}", posted_conv or ""):
        conv = posted_conv
        # The page named the conversation it is in and this window has no name yet: it takes that name.
        # Naming it something else is how one conversation came to be stored twice, once under the page's
        # name and once under the machine's.
        with HISTORY_LOCK:
            if not SESSION.get("id"):
                SESSION["id"] = posted_conv
                warm_prewarm_for(agent_session_name(posted_conv))
    else:
        # No conversation named by the caller. A shared process-wide window meant two clients that
        # never named one wrote into the same conversation. The name is derived from the caller's own
        # credential instead: stable for that device, distinct from every other, so nothing is shared
        # and no request is silently routed into someone else's chat.
        _tok = ""
        try:
            _tok = cookie_token(request) or ""
        except Exception:
            _tok = ""
        if _tok:
            conv = hashlib.sha256(("conv|" + _tok).encode()).hexdigest()[:32]
        else:
            conv = _session_key()
        if conv == "current":
            # A conversation takes its name from its first turn, not only from a reset. A window that has
            # never been reset has no name of its own, and every such window filing under one placeholder
            # is how two unrelated conversations become one row — and how one conversation, answered while
            # he was looking elsewhere, becomes two.
            with HISTORY_LOCK:
                if _session_key() == "current":
                    SESSION["id"] = uuid.uuid4().hex      # a name for this window, and nothing else moves
                    conv = SESSION["id"]
    # The turn claims the newest-turn slot of its own conversation and no other: starting a chat
    # elsewhere must not invalidate work already running here.
    if tombstoned(conv):
        # A conversation that was deleted stays deleted. A stale page, an offline queue or a second
        # device holding an old copy would otherwise reopen it: nothing is minted, nothing is filed.
        return JSONResponse({"error": "conversation was deleted",
                             "conv": conv, "gone": True}, status_code=410)
    # Named now, from the question, on a thread of its own: a turn that searches the web takes minutes and
    # the drawer should not sit on a raw question for all of it. The record is created here so the namer
    # has somewhere to write; a turn that produces nothing takes that empty record away with it.
    _made_here = _touch_conversation(conv, q)
    try:
        threading.Thread(target=name_conversation, args=(conv, q, ""), daemon=True).start()
    except Exception:
        pass
    # The same question, asked twice with the same id, is answered once. A phone that lost the network
    # after sending retries when it comes back; without this the retry would be a second turn, and the
    # chat would carry his question twice with two different answers under it. The answer already
    # given is handed back, in the same shape a live turn would have arrived in.
    if posted_tid:
        # A turn still in the machine's own log — running or just finished — is the common retry case.
        # Its whole event stream is kept there, so the retry is answered with exactly what the first
        # attempt saw, and no second turn is created.
        _chan_dup = None
        with TURN_CHANS_LOCK:
            for _c in TURN_CHANS.values():
                if str(getattr(_c, "tid", "") or "") == posted_tid and str(getattr(_c, "conv", "") or "") == str(conv):
                    _chan_dup = _c
                    break
        if _chan_dup is not None:
            print("turn %s repeats %s: replaying the turn already run" % (my_turn, posted_tid))
            _dup_q = str(getattr(_chan_dup, "question", "") or q)
            _dup_mode = str(getattr(_chan_dup, "mode", "") or mode)

            async def replay_turn():
                yield sse("open", {"t": time.time(), "turn": 0, "tid": posted_tid, "conv": conv,
                                   "attach": True, "q": _dup_q})
                yield sse("format", {"shape": route_format(_dup_q), "mode": _dup_mode})
                with _chan_dup.lock:
                    _ev = [(n, d) for (_s, n, d) in _chan_dup.events]
                for (_n, _d) in _ev:
                    yield sse(_n, _d)
                if not any(_n == "done" for (_n, _d) in _ev):
                    yield sse("done", {})
            return StreamingResponse(replay_turn(), media_type="text/event-stream",
                                     headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
        _stored = None
        with SESSIONS_LOCK:
            _s = SESSIONS.get(conv) or {}
            for _t in (_s.get("turns") or []):
                if str(_t.get("tid") or "") == posted_tid:
                    _stored = _t
                    break
        if _stored is not None:
            print("turn %s is a repeat of %s: handing back the answer already given" % (my_turn, posted_tid))
            _q = q
            _a = str(_stored.get("a") or "")
            _shape = route_format(q)
            _mode = mode

            async def replay_stored():
                yield sse("open", {"t": time.time(), "turn": 0, "tid": posted_tid, "conv": conv,
                                   "attach": True, "q": _q})
                yield sse("format", {"shape": _shape, "mode": _mode})
                if _a:
                    yield sse("tok", {"d": _a, "kind": "front"})
                    yield sse("text", {"text": _a})
                yield sse("done", {})
            return StreamingResponse(replay_stored(), media_type="text/event-stream",
                                     headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    # One turn at a time per conversation. Two writers into one chat give one question two answers, and
    # no page-side guard can stop a second tab, a phone that woke mid-turn, or a retried send. The
    # refusal names the turn in the way so the page can offer to stop it and ask again. Other
    # conversations are untouched: this is per chat, not per person.
    with TURN_CHANS_LOCK:
        for _t, _c in TURN_CHANS.items():
            if str(getattr(_c, "conv", "") or "") == str(conv) and not getattr(_c, "done", True):
                print("turn %s refused: conversation %s still answering turn %s" % (my_turn, conv[:8], _t))
                return JSONResponse({"ok": False, "error": "busy",
                                     "turn": str(_t),
                                     "tid": str(getattr(_c, "tid", "") or ""),
                                     "q": str(getattr(_c, "question", "") or "")[:200]},
                                    status_code=409)
    own_turn(conv, my_turn)
    abandoned = {"yes": False, "conv": conv}
    chan = TurnChan(my_turn, q, mode, conv, tid=(posted_tid or _turn_tid(conv, my_turn)))
    with LIVE_LOCK:
        LIVE_TURNS[my_turn] = abandoned
    with TURN_CHANS_LOCK:
        TURN_CHANS[my_turn] = chan
    _sweep_turns()

    async def gen():
        loop = asyncio.get_running_loop()
        backlog, inbox, already_done = chan.attach(loop)

        # One terse line per turn, for the change log: the numbers every later change is compared
        # against. Timestamps are taken where the event actually leaves, not where it is made.
        stats = {"t0": time.time(), "tok": None, "audio": None, "work": None}

        class Chan:
            """The work runs in a thread, so every event it makes is handed to the turn's own channel:
            from there to every reader attached to it, and into the log a reader who comes back later
            is handed, so the connection and the turn stop being the same thing."""
            def put(self, item):
                name, data = item[0], item[1]
                if name in ("tok", "audio", "work") and stats.get(name) is None:
                    stats[name] = time.time() - stats["t0"]
                chan.publish(name, data)

        out = Chan()
        counter = [0]
        work = {"needed": False, "said": False}

        def run():
            my = my_turn
            snapshot = recall(conv)
            spoken_total = []
            spoken_clean = []                  # what JARVIS actually said, markers removed
            completed = False
            agent_spoken = ""                  # the agent's spoken reply, when a handoff happened
            handoff_status = ""                # "", or the non-ok status that replaced the answer
            _presentation_status = "ok"
            _presentation_errors = []
            _presentation_diagnostics = []

            def stop():
                return abandoned["yes"]

            speaker = None
            try:
                speaker = Speaker(out, counter, depth=3) if mode == "voice" else QuietSpeaker()

                # 1. the fast layer answers immediately
                spoken = ""
                buf = ""
                held = ""
                def read_event(kind, tool, line):
                    if kind == "run" and len(chan.steps) < 40:
                        chan.steps.append("Checked public sources")
                    out.put(("term", {"kind": kind, "tool": tool, "line": line, "ok": kind != "err", "title": "Public sources"}))
                def presentation_error(value):
                    item = {key: _redact.redact(str(value.get(key, "")))[:240] for key in ("phase", "code", "message")}
                    _presentation_diagnostics.append(item)
                    out.put(("note", {"text": "", "presentation_errors": [item["message"]], "presentation_diagnostics": [item]}))
                fs = front_stream(q, snapshot, mode, network=not web_off,
                                  on_event=read_event, require_web=want_web, reasoning=effort, stop=stop,on_diagnostic=presentation_error)
                # Text delegates only through the model's explicit request_task call. The paused
                # voice path retains its existing work/settings routing.
                workish = False if mode == "text" else bool(WORKISH.search(q))
                # Text applies web/memory/reasoning in the presenter and public-read bridge above.
                wants = []
                if reasoning not in ("none", AUTO_REASONING):
                    wants.append("reasoning " + reasoning)
                if want_web:
                    wants.append("a web search")
                if not want_memory:
                    wants.append("no stored memory")
                if mode != "text" and wants and not workish:
                    print("turn wants %s: the fast layer cannot, so the agent answers"
                          % ", ".join(wants))
                    workish = True
                if workish:
                    print("request is shaped like work: handing the question to the agent")
                    work["needed"] = True
                    try:
                        fs.close()
                    except Exception:
                        pass
                def text_deltas():
                    try:
                        yield from fs
                    except OPENUI.RequestWork:
                        work["needed"] = True
                for delta in (() if workish else text_deltas()):
                    if isinstance(delta, OPENUI.Replacement):
                        spoken = str(delta); buf = ""; held = ""
                        out.put(("text", {"text": spoken}))
                        continue
                    if stop():
                        # Explicitly close the generator so the HTTPS response is torn down rather
                        # than left streaming tokens nobody will hear.
                        fs.close()
                        break
                    buf += delta
                    if mode != "text" and WORK_MARK in buf:
                        # The words before the marker are an announcement that work is starting,
                        # never an answer: he wants quiet while it runs, so none of it is spoken
                        # or shown. The result is what he hears.
                        work["needed"] = True
                        held = ""
                        buf = ""
                        break
                    if mode != "text" and is_markup(buf):
                        # The fast layer tried to call a tool. Never speak or show that:
                        # keep whatever real words came before it, then hand the job to
                        # the agent, which is what was actually being asked for.
                        head = scrub(MARKUP.split(buf)[0])
                        if head and not work["said"]:
                            speaker.submit(head, "front")
                            work["said"] = True
                        work["needed"] = True
                        held = ""
                        buf = ""
                        break
                    # A reply that opens by promising the work is an announcement, not an answer.
                    # He asked for intelligence or quiet while the work runs, and never for a line
                    # about work that is not being done, so none of it is spoken or shown.
                    if mode != "text" and not work["needed"] and PROMISE.match((held + buf).strip()):
                        print("fast layer opened with a promise: handing over, nothing spoken")
                        work["needed"] = True
                        held = ""
                        buf = ""
                        break
                    spoken += delta
                    # emit only characters that cannot be part of a marker
                    held += delta
                    keep = 28                        # hold back enough to judge a short opening
                    if len(held) > keep:
                        piece = held[:-keep]
                        # hold back any trailing angle/pipe char: it may open markup
                        while piece and piece[-1] in "<|\uff5c":
                            piece = piece[:-1]
                        if piece:
                            out.put(("tok", {"d": piece, "kind": "front"}))
                            held = held[len(piece):]
                    done, buf = units(buf)
                    for s in done:
                        s = scrub(s)                 # the fast path spoke raw markup before this
                        if not s:
                            continue
                        speaker.submit(s, "front")
                if held and not work["needed"]:
                    tail = held if not is_markup(held) and not NOISE.match(held) else ""
                    tail = drop_partial_marker(tail)
                    if tail.strip():
                        out.put(("tok", {"d": tail, "kind": "front"}))
                    held = ""
                if buf.strip() and not work["needed"]:
                    tail_text = drop_partial_marker(buf.strip())
                    if tail_text:
                        speaker.submit(tail_text, "front")

                if mode != "text" and not spoken.strip() and not work["needed"] and not work["said"]:
                    # The fast layer produced nothing at all. Silence is not an answer, so the
                    # question goes to the agent, which can answer it.
                    print("fast layer produced nothing: handing the question to the agent")
                    work["needed"] = True

                if (mode != "text" and not work["needed"] and len(spoken.strip()) <= 60
                        and PROMISE.match(spoken.strip())):
                    # Everything it said was a promise to act. Saying "on it" is not doing it, and
                    # a turn that only promises is the worst kind of answer: it reads as work
                    # started and leaves the screen untouched. Send the job where the work happens.
                    print("fast layer only promised: handing the question to the agent")
                    work["needed"] = True

                if spoken.strip() and not work["needed"]:
                    # Never let the control marker into the remembered conversation. The marker
                    # can arrive split across deltas, so the hold-back buffer leaves a partial
                    # "[[WORK" behind: drop it. This only became visible once the opener started
                    # being remembered for a handoff. A handed-over turn said nothing worth
                    # keeping, and remembering its announcement teaches the next turn to announce.
                    if mode == "text":
                        _presentation_status, spoken = OPENUI.finalize(spoken, diagnostics=_presentation_errors)
                        if _presentation_status == "partial":
                            out.put(("note", {"text": "", "partial": True,
                                              "presentation_errors": [_redact.redact(e) for e in _presentation_errors] or ["presentation_incomplete: the answer did not complete"]}))
                    spoken_total.append(drop_partial_marker(spoken.split(WORK_MARK)[0]).strip())

                # A voice-only screen answers but never hands work to the agent: a TV in a room
                # other people can see and use should not be able to drive him.
                if work["needed"] and scope == "voice":
                    print("turn %s: this screen is voice-only, not handing over" % my_turn)
                    out.put(("cue", {"name": "phoneonly"}))
                    out.put(("err", {"message": "This screen only answers, sir. Ask me on your phone.",
                                     "type": "voice_only"}))
                    work["needed"] = False

                # 2. the real work, delegated, fed back in when it lands
                if work["needed"]:
                    out.put(("work", {"state": "start"}))
                    try:
                        holder = {}
                        # What is true of this turn while it runs: the steps that have started, and
                        # where the screen log stood when it began. Both feed progress_line, and
                        # both are facts rather than guesses.
                        facts = []
                        art_mark = len(ART_LOG)
                        told = [0.0]          # when the agent last spoke for itself

                        live_sent = [False]
                        web_ran = [False]       # this turn's actual tool event, not a prior execution row

                        def tell(kind, tool, line, ms=None, title=None):
                            if kind == "replace":
                                live_sent[0] = True
                                out.put(("text", {"text": line}))
                                return
                            if kind == "live":
                                # Provisional answer text. The finished answer still replaces it at
                                # the end of the turn, so this is only what the page shows while the
                                # model is writing, never the record.
                                live_sent[0] = True
                                out.put(("tok", {"d": line, "kind": "agent"}))
                                return
                            if kind == "note":
                                # The agent's own words about its work: straight to the sheet, which
                                # nests them under the step they belong to. While they are arriving,
                                # the invented progress line stands down, because an agent that is
                                # narrating does not need the server speaking for it.
                                told[0] = time.time()
                                out.put(("note", {"text": line}))
                                return
                            if kind == "run" and tool in WEB_CAPABLE:
                                web_ran[0] = True
                            if kind == "run" and len(facts) < 12:
                                facts.append((title or tool or "a step")[:70])
                                try:
                                    if len(chan.steps) < 40:
                                        chan.steps.append((title or line or tool or "a step")[:120])
                                except Exception:
                                    pass
                            out.put(("term", {"kind": kind, "tool": tool, "line": line,
                                              "ms": ms, "ok": kind != "err",
                                              "title": title or ""}))

                        def go():
                            # One agent at a time on this machine, so a turn asked in a second chat waits
                            # for the first. It says so, on its own conversation, instead of showing a
                            # silent spinner for a minute and looking broken.
                            try:
                                if AGENT_RUN_LOCK.locked():
                                    out.put(("note", {"text": "Waiting for the turn already running…"}))
                            except Exception:
                                pass
                            held = AGENT_RUN_LOCK.acquire(timeout=AGENT_RUN_WAIT)
                            if not held:
                                holder["result"] = ("failed", "")
                                return
                            _turn_started = time.time()
                            try:
                                if stop():
                                    return
                                _warm = None
                                # The page can draw declared components, but nothing ever told the model
                                # that they exist: every card so far arrived only because the operator
                                # pasted the JSON himself. The contract travels with the question, never
                                # with the stored record, so what he sees saved is still his own words.
                                ask_q = q
                                try:
                                    _note = RESPONSE_LAYER.prompt_note()
                                    if _note and mode != "text":
                                        ask_q = q + "\n" + _note
                                except Exception as _ne:
                                    print("response note unavailable: %r" % (_ne,), flush=True)
                                print("ask prompt: q=%d chars, note=%d chars, total=%d" % (len(q), len(ask_q)-len(q), len(ask_q)), flush=True)
                                if mode != "text" and (not want_web) and want_memory:
                                    try:
                                        _sec_w = secrets.token_hex(16)
                                        with approval_lock():
                                            APPROVAL_SECRETS[(str(conv or ""), "")] = _sec_w
                                        write_turn_ctx(str(conv or ""), os.path.join(HERE, "modes.json"),
                                                       os.environ.get("JARVIS_WEB_GUARD") or "deny",
                                                       os.path.join(HERE, "logs", "web_guard.log"),
                                                       _sec_w,
                                                       "http://127.0.0.1:%d/agent/ask" % PORT,
                                                       "auto" if AUTO_ENABLED else "ask")
                                        _warm = warm_answer(ask_q, stop, tell, reasoning=effort,
                                                            screen=(mode == "text"), conv=conv)
                                        print("warm turn: used=%s name=%s" % (bool(_warm), agent_session_name(conv)),
                                              flush=True)
                                    except Exception as _we:
                                        print("warm path unavailable: %r" % (_we,), flush=True)
                                        _warm = None
                                holder["result"] = _warm if _warm else hermes_answer(
                                    ask_q, stop, tell, mode, effort,
                                    want_web, want_memory, conv=conv, web_off=web_off)
                                if want_web:
                                    # The execution row is written as the turn closes, so give it a moment
                                    # before judging rather than reading a record that is not there yet.
                                    used = web_ran[0] if mode == "text" else web_used(conv, my_turn, since=_turn_started)
                                    for _ in range(0 if mode == "text" else 6):
                                        if used:
                                            break
                                        time.sleep(0.5)
                                        used = web_used(conv, my_turn, since=_turn_started)
                                    print("web always: searched=%s tid=%s" % (used, my_turn), flush=True)
                                    if not used and (mode != "text" or (holder.get("result") or ("failed",))[0] == "ok"):
                                        print("web always: no search on this turn, rerunning once with a "
                                              "stronger instruction tid=%s" % my_turn, flush=True)
                                        holder["result"] = hermes_answer(
                                            q, stop, tell, mode, effort, True, want_memory,
                                            conv=conv, web_off=False)
                                        used2 = web_ran[0] if mode == "text" else web_used(conv, my_turn, since=_turn_started)
                                        print("web always: after retry searched=%s tid=%s"
                                              % (used2, my_turn), flush=True)
                                        if mode == "text" and not used2:
                                            holder["result"] = ("failed", "Always search required a web tool on this turn.")
                            except Exception as e:
                                # A crash in the worker must not look like an empty answer.
                                holder["result"] = ("failed", "")
                                print("agent worker crashed: %r" % (e,))
                            finally:
                                if held:
                                    AGENT_RUN_LOCK.release()

                        th = threading.Thread(target=go, daemon=True)
                        th.start()
                        # With no bridging line to cover the wait, the first progress line comes
                        # sooner.
                        waited, gap = 0.0, (14.0 if work["said"] else 6.0)
                        used = []
                        # The only limit is the agent's own timeout now; the outer wait just
                        # watches the worker and the stop flag.
                        # This wait belongs to a worker thread, not the event loop, so joining here
                        # costs nothing but this turn: the loop keeps serving the page, the drawer and
                        # any other conversation while it waits.
                        while th.is_alive() and not stop():
                            th.join(timeout=gap)
                            if th.is_alive():
                                waited += gap
                                # Once the screen has the answer, the screen IS the message: no
                                # further line is generated, spoken or captioned. This is the half
                                # that stops the voice talking about a panel he is already looking
                                # at.
                                shown = panels_since(art_mark)
                                # An agent that is narrating its own work does not need the server
                                # inventing lines over the top of it: the sheet would carry two
                                # accounts of one job.
                                narrating = bool(told[0]) and (time.time() - told[0]) < 25
                                line = "" if (shown or narrating) else progress_line(q, used, facts, shown)
                                if line:
                                    used.append(line)
                                    # Spoken under its own kind so the page keeps it out of the
                                    # caption: a progress line belongs in the Summary, not as the
                                    # largest text on the screen over his chart.
                                    speaker.submit(line, "progress")
                                    # A note, not a caption.
                                    out.put(("note", {"text": line}))
                                gap = min(gap * 2, 45.0)
                        if stop():
                            print("turn %s abandoned: nothing is spoken and nothing is kept" % my)
                            return
                        status, answer = holder.get("result") or ("failed", "")
                        handoff_status = status       # ok means the handoff may be remembered
                        if status == "stopped":
                            return                     # he hung up: nothing is said, nothing kept
                        if status == "partial":
                            # A delivered calculation whose interactive form failed. The answer is
                            # real and the arithmetic is kept; what did not happen is the control.
                            # The page is told so before the words arrive, so the pill settles on
                            # TEXT ONLY rather than claiming the interaction worked.
                            out.put(("note", {"text": "", "partial": True, "presentation_errors": ["task_presenter_partial: the task presenter returned an incomplete answer"]}))
                        if status not in ("ok", "partial"):
                            if mode == "text":
                                print("ERROR agent turn failed: conv=%s status=%s" % (conv, status), flush=True)
                                out.put(("err", {"message": "The agent turn failed before a complete answer was produced. Please try again.",
                                                 "type": "agent_" + status}))
                                return
                            # An error is never spoken as if it were the answer, and never
                            # remembered as a conversation. A recorded cue says it in his voice.
                            # Unless the screen already holds the answer: a turn that put the
                            # widget up and then ran out of road must not have "that one ran long"
                            # spoken over it, which reads as a failure to do the thing he can see.
                            if panels_since(art_mark):
                                print("handoff %s, but the screen has the answer: no error spoken"
                                      % status)
                            else:
                                out.put(("cue", {"name": AGENT_CUES.get(status, "agentfailed")}))
                                out.put(("err", {"message": AGENT_SAYS.get(status, "That did not work."),
                                                 "type": "agent_" + status}))
                        if status in ("ok", "partial") and answer:
                            agent_spoken = answer
                            # Split the answer into speakable units, exactly as the fast layer's
                            # text is split: the agent returns its whole answer as ONE line, and
                            # one unit per line sent sixty seconds of speech in a single request.
                            whole, tail = units(answer + " ")
                            for piece in whole:
                                if stop():
                                    break
                                speaker.submit(piece, "agent")
                                # The page already painted these words as they were written; a
                                # second pass would print the answer twice. The speech still goes
                                # out in full, because that path was never the duplicate.
                                if not live_sent[0]:
                                    out.put(("tok", {"d": piece + " ", "kind": "agent"}))
                            if tail.strip() and not stop():
                                speaker.submit(tail, "agent")
                                if not live_sent[0]:
                                    out.put(("tok", {"d": tail + " ", "kind": "agent"}))
                        out.put(("work", {"state": "done"}))
                    except Exception as e:
                        out.put(("work", {"state": "failed", "err": str(e)[:140]}))
                completed = not work["needed"] or handoff_status in ("ok", "partial")
            except Exception as e:
                _presentation_errors.append(_redact.redact(str(e))[:240])
                out.put(("err", {"message": str(e)[:200], "type": "model_failed"}))
            finally:
                # Everything the speaker has been asked to say is written out before the turn is
                # closed, so the page never hears "done" with audio still on its way.
                if speaker is not None:
                    if stop():
                        speaker.abort()
                    else:
                        speaker.close(timeout=45.0)
                with approval_lock():
                    APPROVAL_SECRETS.pop((str(conv or ""), ""), None)
                    approvals_store().expire("turn ended", chat=str(conv or ""))
                with LIVE_LOCK:
                    LIVE_TURNS.pop(my_turn, None)
                # a failed, disconnected or abandoned turn must not be recorded as a real
                # conversation: it would put words in his mouth on the next turn
                # One assistant message per turn: the opener and the agent's answer together for
                # a handoff, and nothing at all when the handoff failed.
                if work["needed"]:
                    parts = [spoken_total[0] if spoken_total else "", agent_spoken]
                    said = " ".join(p for p in parts if p).strip() if handoff_status in ("ok", "partial") else ""
                else:
                    said = " ".join(spoken_total).strip()
                # An answer that was actually produced is written down even when the client left
                # before it arrived: the tokens are already spent, and the answer to the question he
                # asked is still the answer whether he heard it or not. The page reads the last turn
                # back when it loads, so a dropped connection costs him a delay instead of the whole
                # turn. A run that was killed before it produced anything still records nothing.
                if said and not is_markup(said) and len(said) > 2 and (completed or stop()):
                    # Where the answer goes is decided by the conversation it was asked in, not by the
                    # window that happens to be open now. A window that has rotated since the ask (he
                    # started a new conversation while this one was still working) must not take the
                    # answer: written into its history it would become a reply to a question that was
                    # never asked of it. Filed by name, it stays his answer to his own question.
                    if conv and str(conv) != str(_session_key()):
                        try:
                            _ms2 = int((time.time() - float(getattr(chan, "started", time.time()))) * 1000)
                        except Exception:
                            _ms2 = None
                        _session_keep_turn(conv, q, said, _ms2, list(getattr(chan, "steps", []) or []),
                                           started_at=getattr(chan, "started", None))
                        wrote = False
                        print("turn %s finished after its window moved on: kept with %s" % (my, conv[:12]))
                    else:
                        wrote = commit(my, q, said, conv=conv)
                    # The conversation's own record keeps every finished turn, whoever else is writing: the
                    # window is the live surface, not the store. This is what makes opening a chat from the
                    # list show all of it — a chat whose earlier turns only ever reached the window came
                    # back as its last answer with nothing above it, which is the answer that was missing.
                    if wrote and conv and not stop():
                        try:
                            _ms = int((time.time() - float(getattr(chan, "started", time.time()))) * 1000)
                        except Exception:
                            _ms = None
                        _session_keep_turn(conv, q, said, _ms, list(getattr(chan, "steps", []) or []),
                                           started_at=getattr(chan, "started", None))
                    if not wrote and completed and not stop():
                        # The live window has moved on — he started a new conversation while this one
                        # was still working, or the window timed out — so the answer cannot go into the
                        # live history without becoming an answer to the new conversation's question.
                        # It goes where it belongs: the record of the conversation it was asked in.
                        _session_keep_turn(conv, q, said)
                        print("turn %s finished after its window moved on: kept with %s"
                              % (my, conv[:12]))
                    elif stop():
                        print("turn %s was stopped: the words are not recorded" % my)
                else:
                    print("turn %s ended without completing: not recorded" % my)
                    _drop_empty_conversation(conv)

                def _t(key):
                    seen = stats.get(key)
                    return ("%.1fs" % seen) if seen is not None else "-"

                # One terse line per turn: the before and after numbers every later item is
                # compared against. Timed where each event leaves, not where it is made.
                print("turn %s: tok=%s audio=%s work=%s done=%.1fs handoff=%s end=%s chars=%d" % (
                    my, _t("tok"), _t("audio"), _t("work"), time.time() - stats["t0"],
                    "yes" if work["needed"] else "no",
                    "completed" if (completed and not stop()) else ("abandoned" if stop() else "error"),
                    len(said)))
                try:
                    if mode == "text" and said:
                        # The whole answer in one event. The page has been writing the tokens as they
                        # arrived; this is the settled text, so a dropped delta cannot leave a
                        # truncated answer on the screen.
                        out.put(("text", {"text": said}))
                    if mode == "text":
                        _verdict = ("cancelled" if stop() else "failed" if not completed else
                                    "partial" if _presentation_status == "partial" or handoff_status == "partial" else "ok")
                        _errors = [_redact.redact(e) for e in _presentation_errors]
                        if _verdict in ("partial", "failed") and not _errors:
                            _errors = [d["message"] for d in _presentation_diagnostics] or ["presentation_incomplete: the turn ended with " + _verdict]
                        out.put(("done", {"status": _verdict, "evidence_version": 3,
                                          "presentation_errors": _errors,
                                          "presentation_diagnostics": _presentation_diagnostics}))
                    else:
                        out.put(("done", {}))
                finally:
                    # The turn is over and its channel is told so even if the event above raised: a
                    # reader waiting on it must never be left hanging on a turn that has ended.
                    # How it ended travels with the record: a stopped turn must never be filed as
                    # one that completed, and a turn that died must never read as WORKED.
                    chan.finish("cancelled" if stop() else ("completed" if completed else "failed"))

        threading.Thread(target=run, daemon=True).start()
        # The conversation travels with the turn it belongs to: the page learns the name the machine filed
        # it under, which is the name every later save has to use.
        yield sse("open", {"t": time.time(), "turn": my_turn, "tid": (chan.tid or _turn_tid(conv, my_turn)), "conv": conv})
        yield sse("format", {"shape": route_format(q), "mode": mode})
        try:
            # What this reader missed before it arrived: nothing on a fresh turn, and everything it had
            # not seen on one it is re-attaching to.
            for (name, data) in backlog:
                yield sse(name, data)
            if already_done:
                return
            while True:
                try:
                    name, data = await asyncio.wait_for(inbox.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    # keep the pipe warm so a long silent agent run cannot idle it shut
                    yield ": ping\n\n"
                    continue
                if name == "__end__":
                    break
                yield sse(name, data)
                if name == "done":
                    break
        finally:
            # The reader left — a tap on another conversation, a closed tab, a lost signal. The TURN
            # does not leave with it: it is work he asked for and it is writing itself into the
            # conversation it belongs to, so it runs to the end and a page that comes back attaches to
            # it. Only an explicit stop (/cancel) ends a turn early now. This block is the reason the
            # generator is a coroutine: a thread-wrapped generator parked at a yield with nobody
            # consuming it is never closed at all.
            chan.detach(inbox)
            if not chan.done:
                print("turn %s: reader left, the work carries on" % my_turn)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform",
                                      "X-Accel-Buffering": "no", "Connection": "keep-alive"})


@app.post("/stream/attach")
async def stream_attach(request: Request):
    """Re-bind to a turn that is still running (or finished a moment ago).

    Opening a conversation starts nothing: if the turn that belongs to it is still working, this hands
    the page everything it has not seen, in order, and then the live stream. Same framing as /stream,
    so one reader in the page serves both and no second way of reading a turn is invented. A page that
    comes back mid-answer gets the transcript, the steps and the ending rather than a dropped link.
    """
    scope = auth_scope(request)
    if scope is None:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    if not same_origin(request):
        return JSONResponse({"error": "cross-site"}, status_code=403)
    try:
        payload = json.loads((await request.body()) or b"{}")
    except Exception:
        return JSONResponse({"error": "malformed body"}, status_code=400)
    if str(payload.get("turn") or "").startswith("page."):
        return await PAGE_TEXT.attach(request, payload)
    try:
        want = int(payload.get("turn"))
        since = max(0, int(payload.get("since") or 0))
    except Exception:
        return JSONResponse({"error": "bad turn"}, status_code=400)
    with TURN_CHANS_LOCK:
        chan = TURN_CHANS.get(want)
    if chan is None:
        return JSONResponse({"ok": False, "error": "no such turn", "turn": want}, status_code=404)

    async def gen():
        loop = asyncio.get_running_loop()
        backlog, inbox, done = chan.attach(loop, since)
        try:
            # The turn's own question and conversation travel with the hand-over: a page that re-binds
            # without them would save the answer under a blank name.
            yield sse("open", {"t": time.time(), "turn": want, "tid": (getattr(chan, "tid", "") or _turn_tid(getattr(chan, "conv", "") or "", want)), "attach": True,
                               "q": getattr(chan, "question", "") or "",
                               "conv": getattr(chan, "conv", "") or ""})
            for (name, data) in backlog:
                yield sse(name, data)
            if done:
                # A turn that has ended is handed over complete, ending included: a page that arrives
                # this late is reading the turn, not waiting on it.
                if not any(name == "done" for (name, _d) in backlog):
                    yield sse("done", {})
                return
            while True:
                try:
                    name, data = await asyncio.wait_for(inbox.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                if name == "__end__":
                    break
                yield sse(name, data)
                if name == "done":
                    break
        finally:
            chan.detach(inbox)
            print("turn %s: a reader attached, and left" % want)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform",
                                      "X-Accel-Buffering": "no", "Connection": "keep-alive"})


# ---------------------------------------------------------------------------
# Conversations kept: the record behind the history drawer
# ---------------------------------------------------------------------------
# The page's own memory is the window he is in and it rotates by design, so a conversation that ended
# was simply gone. This keeps the windows: each one is archived at the moment it closes, listed for
# the drawer, and readable back onto the canvas.
SESSIONS_FILE = os.path.join(HERE, "sessions.json")
SESSIONS = {}                    # id -> {"id","title","started","updated","turns":[{"q","a","t"}]}
SESSIONS_LOCK = threading.RLock()  # reentrant: a helper that takes this lock must be callable while it is held
SESSIONS_MAX = 60                # conversations kept; past this the oldest go first

# --- tombstones: a conversation that was deleted stays deleted -----------------------------------------
# Two writers still touch this store: the turn worker at finish and the page when it saves its copy.
# A page that was offline, or a second device holding an old copy, can therefore ask for a chat that
# no longer exists — and until now that ask brought the chat back. A tombstone is the record that the
# id was deliberately removed, so a late save or a late turn is refused instead of resurrecting it.
TOMBSTONES_FILE = os.path.join(HERE, "tombstones.json")
TOMBSTONES = {}                  # id -> {"deletedAt": epoch, "backup": path, "turns": n}
TOMBSTONES_LOCK = threading.RLock()
BACKUP_DIR = os.path.join(HERE, "backups")
BACKUP_RETENTION_DEFAULT = 30    # days; jarvis_live.backup_retention_days in config.yaml overrides it


def _tombstones_read():
    try:
        with open(TOMBSTONES_FILE, encoding="utf-8") as f:
            d = json.load(f) or {}
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _tombstones_write():
    """Called with TOMBSTONES_LOCK held; atomic like every other store here."""
    try:
        tmp = TOMBSTONES_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(TOMBSTONES, f)
        os.replace(tmp, TOMBSTONES_FILE)
    except Exception as e:
        print("tombstones: could not save: %r" % (e,))


def tombstoned(sid):
    sid = str(sid or "").strip()
    if not sid:
        return False
    with TOMBSTONES_LOCK:
        return sid in TOMBSTONES


def tombstone_add(sid, backup="", turns=0):
    sid = str(sid or "").strip()
    if not sid:
        return
    with TOMBSTONES_LOCK:
        TOMBSTONES[sid] = {"deletedAt": time.time(), "backup": backup or "", "turns": int(turns or 0)}
        _tombstones_write()
    print("tombstone: %s recorded as deleted" % sid)


def backup_retention_days():
    """How long a safety copy is kept. One config value, read per use, defaulting to 30 days."""
    try:
        import yaml
        with open(os.path.join(HERMES, "config.yaml"), encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
        v = (cfg.get("jarvis_live") or {}).get("backup_retention_days")
        if v is None:
            return BACKUP_RETENTION_DEFAULT
        v = int(v)
        return v if v >= 1 else BACKUP_RETENTION_DEFAULT
    except Exception:
        return BACKUP_RETENTION_DEFAULT


def prune_backups():
    """Drop safety copies older than the retention window. Returns (removed, kept)."""
    days = backup_retention_days()
    cutoff = time.time() - days * 86400
    removed = kept = 0
    try:
        for name in os.listdir(BACKUP_DIR):
            p = os.path.join(BACKUP_DIR, name)
            try:
                if os.path.isdir(p):
                    when = os.path.getmtime(p)
                else:
                    when = os.path.getmtime(p)
            except Exception:
                continue
            if when < cutoff:
                try:
                    shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
                    removed += 1
                except Exception as e:
                    print("backups: could not remove %s: %r" % (name, e))
            else:
                kept += 1
    except FileNotFoundError:
        pass
    return removed, kept


# The word the page has to send back before the archive is wiped. Not a secret and not a password:
# it is the difference between a request that carries an intent and one that only carries a URL.
CONFIRM_CLEAR = "clear-chat-history"
# A purge leaves a stamp the page can see. The device keeps its own copy of the conversations, and a
# phone that was not open when the purge happened would otherwise still be listing them: the stamp is
# how "the machine was emptied" reaches a device that heard nothing, without ever treating an empty or
# failed read as a reason to throw away a copy the machine might not have.
PURGE_FILE = os.path.join(HERE, "purge.json")
CONFIRM_FORGET = "forget-this-chat"

# --- the node's own UI contract ------------------------------------------------------------------------
# Appearance, speech and the screen's transcript depth are the page's own business, so they live in a file
# this server owns and the client mirrors into localStorage for an instant first paint. Deliberately NOT
# here: the agent's config. A settings screen does not get to rewrite the process that runs his tools.

UI_FILE = os.path.join(HERMES, "node_ui_config.json")
UI_DEFAULTS = {"material": "ink", "mode": "device", "density": "normal",
               "autoplay": True, "transcript_turns": 25}


def _ui_config():
    d = dict(UI_DEFAULTS)
    try:
        with open(UI_FILE, encoding="utf-8") as f:
            stored = json.load(f) or {}
        if isinstance(stored, dict):
            d.update({k: v for k, v in stored.items() if k in UI_DEFAULTS})
    except Exception:
        pass
    return d


def _ui_save(patch):
    d = _ui_config()
    for k, v in (patch or {}).items():
        if k in UI_DEFAULTS:
            d[k] = v
    tmp = UI_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)
    os.replace(tmp, UI_FILE)
    return d


@app.get("/api/v1/node/ui")
async def api_node_ui(request: Request):
    if not _guard(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    return JSONResponse({"ok": True, "ui": _ui_config()})


@app.post("/api/v1/node/ui")
async def api_node_ui_set(request: Request):
    """One control, one value, written through: the file on disk is the record."""
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    patch = {}
    if body.get("density") in ("compact", "normal", "roomy"):
        patch["density"] = body["density"]
    if body.get("material") in ("ink", "frost"):
        patch["material"] = body["material"]
    if body.get("mode") in ("device", "light", "dark"):
        patch["mode"] = body["mode"]
    if "autoplay" in body:
        patch["autoplay"] = bool(body["autoplay"])
    if body.get("transcript_turns") in (10, 25, 0):
        patch["transcript_turns"] = body["transcript_turns"]
    if not patch:
        return JSONResponse({"ok": False, "error": "nothing recognised in that"}, status_code=400)
    return JSONResponse({"ok": True, "ui": _ui_save(patch), "changed": sorted(patch.keys())})


@app.post("/api/v1/node/reload")
async def api_node_reload(request: Request):
    """Re-read this node's own config and drop this server's cached reads. No process restart.

    What it does NOT do, and will not pretend to: reload the agent's skills or config. That process owns its
    own state and has its own reload path; reaching into it from a settings screen is how a page breaks the
    thing it is only supposed to be a window onto.
    """
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    dropped = 0
    # This server's own cached reads, by their real names. Nothing here reaches into the agent.
    try:
        dropped += len(_sys_cache)
        _sys_cache.clear()
    except Exception as e:
        print("node reload: sys cache: %s" % e)
    try:
        dropped += len(_MANIFEST_INDEX.get("idx") or {})
        _MANIFEST_INDEX["idx"] = {}
        _MANIFEST_INDEX["at"] = 0.0
    except Exception as e:
        print("node reload: manifest index: %s" % e)
    try:
        if IDENTITY_CACHE.get("text"):
            dropped += 1
        IDENTITY_CACHE.update({"at": 0, "text": ""})
    except Exception as e:
        print("node reload: identity: %s" % e)
    try:
        VOCAB_CACHE["at"] = None
    except Exception as e:
        print("node reload: vocab: %s" % e)
    prefs = _prefs()
    print("node reload: %d cached read(s) dropped" % dropped)
    return JSONResponse({"ok": True, "dropped": dropped, "ui": _ui_config(),
                         "prefs_keys": sorted(prefs.keys())})


@app.post("/sys/settings/scope")
async def sys_settings_scope(request: Request):
    """Which this device is: may hand work to the agent, or answers only.

    This is the honest form of a tool-execution approval control for this page. The boundary is enforced
    where the work is handed over, so turning it down is a real restriction and turning it up is a real
    grant -- neither is a label over nothing.
    """
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        body = await request.json()
    except Exception:
        body = {}
    want = "full" if str((body or {}).get("scope")) == "full" else "voice"
    tok = cookie_token(request)
    entries = device_entries()
    if tok not in entries:
        return JSONResponse({"ok": False, "error": "this session is not a device row"}, status_code=400)
    e = entries[tok]
    _forget_device(tok)
    new = add_device(e.get("label") or "device", want)
    r = JSONResponse({"ok": True, "scope": want})
    r.set_cookie(COOKIE, new, max_age=COOKIE_MAX_AGE, httponly=True, secure=True, samesite="lax")
    print("device scope set to %s for %s" % (want, (e.get("label") or "?")[:28]))
    return r

CONFIRM_REVOKE = "revoke-other-devices"      # the account page's second, wider logout

# --- the code an answer carried, indexed (10 October 2026) ---------------------------------------
# Every turn that hands him a script, a snippet or a JSON payload leaves that text here, so it can be
# found again from the drawer instead of by scrolling a conversation back to the right screenful. The
# text is kept in this file rather than in the widget store: a widget is a page to look at, and this
# is a document to copy. One entry per distinct snippet, newest first, capped both ways — an answer
# that quotes a whole file is a file, not a snippet, and does not belong in an index of snippets.
ARTIFACT_FILE = os.path.join(HERE, "artifacts.json")
ARTIFACT_LOCK = threading.Lock()
ARTIFACT_INDEX = {}              # id -> {id,kind,created,lang,label,bytes,from,text}
ARTIFACT_MAX = 60                # documents kept
ARTIFACT_TEXT_MAX = 24000        # bytes of any one document
ARTIFACT_PER_TURN = 12           # a turn that produces more than this is a dump, not an answer

JSONISH = ("json", "jsonc", "geojson")


def _artifact_save():
    try:
        ordered = sorted(ARTIFACT_INDEX.values(), key=lambda a: -(a.get("created") or 0))[:ARTIFACT_MAX]
        payload = {a["id"]: a for a in ordered}
        tmp = ARTIFACT_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp, ARTIFACT_FILE)
        for aid in list(ARTIFACT_INDEX):
            if aid not in payload:
                ARTIFACT_INDEX.pop(aid, None)
    except Exception as e:
        print("artifacts: could not save: %r" % (e,))


def _artifacts_load():
    try:
        with open(ARTIFACT_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for aid, a in data.items():
                if isinstance(a, dict) and isinstance(a.get("text"), str):
                    ARTIFACT_INDEX[str(aid)] = {
                        "id": str(aid), "kind": "code", "created": float(a.get("created") or 0),
                        "lang": str(a.get("lang") or "text"), "label": str(a.get("label") or "")[:120],
                        "bytes": int(a.get("bytes") or len(a["text"])), "from": str(a.get("from") or "")[:80],
                        "text": a["text"],
                    }
    except Exception:
        pass


_FENCE = re.compile(r"```[ \t]*([A-Za-z0-9_+\-.#]{0,20})[ \t]*\r?\n(.*?)```", re.S)
_LANG_ALIAS = {"py": "python", "js": "javascript", "ts": "typescript", "sh": "bash", "shell": "bash",
               "yml": "yaml", "md": "markdown", "html": "html", "ps1": "powershell", "": "text"}


def _looks_like_json(s):
    s = (s or "").strip()
    if not s or s[0] not in "{[":
        return False
    try:
        json.loads(s)
        return True
    except Exception:
        return False


def _code_blocks(text):
    """The scripts and payloads in an answer.

    Fenced blocks are the contract every answer already uses. A payload that is the whole answer, with
    no fence around it, is the one other shape worth catching, because a JSON reply sent as raw text
    is still a thing he will want to copy. Nothing else is guessed at: a paragraph that happens to
    contain braces is prose.
    """
    out, seen = [], set()
    body = text or ""

    def add(lang, code, reason):
        code = code.strip("\n")
        if not code.strip() or len(code) > ARTIFACT_TEXT_MAX:
            return
        key = (lang, code)
        if key in seen:
            return
        seen.add(key)
        first = next((l.strip() for l in code.split("\n") if l.strip()), "")
        out.append({"lang": lang, "text": code, "reason": reason,
                    "label": (first[:76] or lang)})

    for m in _FENCE.finditer(body):
        raw_lang = (m.group(1) or "").strip().lower()
        lang = _LANG_ALIAS.get(raw_lang, raw_lang or "text")
        code = m.group(2)
        if raw_lang in JSONISH or _looks_like_json(code):
            lang = "json"
        add(lang, code, "fenced")
    if not out and _looks_like_json(body):
        add("json", body, "answer")
    return out[:ARTIFACT_PER_TURN]


def _projects():
    """The things he is actually building, by when they were last touched.

    Read off the disk rather than remembered: a list kept by hand goes stale the week after it is
    written, and a suggestion that names a project he finished a month ago reads as a machine that
    has not been paying attention.
    """
    roots = ("/data/apps", "/data/sites", "/data/business")
    found = []
    for root in roots:
        try:
            for name in os.listdir(root):
                if name.startswith(".") or name.startswith("_"):
                    continue
                p = os.path.join(root, name)
                if not os.path.isdir(p):
                    continue
                found.append((os.path.getmtime(p), name, p))
        except Exception:
            continue
    found.sort(reverse=True)
    return found


def _project_label(name):
    """A directory's name as he says it, not as the filesystem spells it."""
    known = {"inspectfirst": "InspectFirst", "jarvis-live": "JARVIS Live", "hermes-webui": "the web UI",
             "jarvis-voice-companion": "the voice companion app"}
    return known.get(name, name.replace("-", " ").replace("_", " "))


def _newest_script():
    """The most recent script of his own, for the chip that offers to look one over."""
    best = (0, "", "")
    for _mtime, name, path in _projects()[:6]:
        try:
            for dirpath, dirnames, filenames in os.walk(path):
                dirnames[:] = [d for d in dirnames if not d.startswith((".", "__", "node_modules"))]
                for fn in filenames:
                    if not fn.endswith(".py"):
                        continue
                    fp = os.path.join(dirpath, fn)
                    m = os.path.getmtime(fp)
                    if m > best[0]:
                        best = (m, fn, fp)
        except Exception:
            continue
    return best


_suggest_seq = 0          # rotates the landing rows so two openings are not the same sentence


def _suggest_chips():
    """The landing rows: one per capability this machine actually has, read off the box.

    Rules, not a model: instant, free, and unable to invent a state the box is not in. Each row
    carries the exact sentence it acts on, and says how it acts:

      mode "send" - the sentence is already the whole request, so the page sends it.
      mode "fill" - the row has no subject yet, so it carries only the OPENING of the sentence
                    ("Search the web for: ") and the page puts that in the box with the cursor at
                    the end of it. A tap on one of these can never spend a turn on a request he has
                    not finished, which is the whole reason the distinction exists.

    The order is fixed: this machine, a new project, the web, the day. Only the day is worded by
    the hour, because the hour changes what he is actually asking for. Nothing here names a file:
    the landing is the app, and the app speaks in capabilities, not in paths.
    """
    hour, rows, alert = time.localtime().tm_hour, [], False

    # 1. Server Telemetry. A number that needs attention leads; otherwise the machine's own figures.
    label, ask = ("Check server health",
                  "Run a system check on this machine and tell me what needs attention.")
    try:
        t = _cached("tel", 30.0, _telemetry)
        free_gb = t["disk"]["free"] / float(1024 ** 3)
        mem_pct = 100.0 * t["mem"]["used"] / max(1, t["mem"]["total"])
        up_days = t["uptime"] / 86400.0
        def _flag(l, a_):
            return (l, a_, True)
        if free_gb < 10:
            label, ask = ("Disk is tight: %.0f GB left" % free_gb,
                          "This machine is down to %.0f GB free. Find what is using the space "
                          "and tell me what is safe to remove." % free_gb)
        elif mem_pct > 88:
            label, ask = ("Memory is at %.0f%%" % mem_pct,
                          "Memory use is at %.0f%% on this machine. What is holding it, and what "
                          "should I do about it?" % mem_pct)
        elif up_days > 21:
            label, ask, alert = _flag("Up %d days: worth a look" % int(up_days),
                                      "This machine has been up %d days. Check it over and tell me "
                                      "if anything needs a restart or an update." % int(up_days))
        else:
            # Nothing is wrong, so the row carries the figure it is really checking instead of the
            # word for checking. Which figure rotates with the hour, so the list does not open with
            # the identical sentence every time he looks at it.
            facts = ["Disk %.1f GB free" % free_gb,
                     "Memory at %.0f%%" % mem_pct,
                     "Up %d days, healthy" % int(up_days)]
            asks = ["How is this machine placed for space, memory and load, and is anything worth "
                    "doing about it?",
                    "Memory use is at %.0f%% on this machine. What is holding it, and does anything "
                    "need attention?" % mem_pct,
                    "This machine has been up %d days. Check it over and tell me if anything needs a "
                    "restart or an update." % int(up_days)]
            label, ask = facts[hour % 3], asks[hour % 3]
    except Exception:
        pass                                        # the routine sweep is already the fallback
    rows.append({"icon": "\U0001FA7A", "kind": "telemetry", "mode": "send", "alert": alert,
                 "label": label, "ask": ask, "sub": "Check on your progress"})

    # 2. New project. The only row that starts something rather than reporting it, and it starts
    #    with a question: the turn it sends asks him what the project is called and nothing else.
    #    Naming is his, so the row cannot guess it, and the work does not begin until he answers.
    rows.append({"icon": "\u2795", "kind": "project", "mode": "send",
                 "label": "New project", "sub": "Name it, then we build it",
                 "ask": "Start a new project with me. Ask me what to call it, and wait for my answer "
                        "before you do or build anything."})

    # 3. Search. The capability itself, with nothing asked of it yet: this is the row that hands the
    #    sentence over rather than sending it, because "search the web" is not a request until it
    #    says what for.
    # One wording, always: the row is the capability, and the subject arrives when he types it.
    rows.append({"icon": "\U0001F310", "kind": "web", "mode": "fill", "ask": "",
                 "label": "Search the web", "sub": "Find anything, with live sources",
                 "prefix": "Search the web for: "})

    # 4. The day. The clock he is holding decides both the words and the question: a briefing at
    #    breakfast, the country at midday, the day again in the evening, and at night what is coming
    #    rather than what has gone. Same row, four different jobs, decided here so the page never
    #    has to guess what time it is for him.
    if 5 <= hour < 11:
        label, sub, ask = ("Morning briefing", "Uganda first, then the world",
                           "Give me a briefing on Uganda first, then the world: what happened "
                           "overnight and what matters today.")
    elif 11 <= hour < 17:
        label, sub, ask = ("Uganda today", "The news, and why it matters",
                           "What is the news in Uganda today, and why does it matter?")
    elif 17 <= hour < 22:
        label, sub, ask = ("Today in review", "What happened, and what is still open",
                           "What happened today in Uganda and the world that I should know about, "
                           "and what is still open?")
    else:
        label, sub, ask = ("Before tomorrow", "What is due, and what the weather does",
                           "What is scheduled for tomorrow, what is due from me, and what is the "
                           "weather going to do?")
    rows.append({"icon": "\U0001F4F0", "kind": "day", "mode": "send",
                 "label": label, "sub": sub, "ask": ask})

    # Fixed order, every landing: the machine, the new project, the web, the day. Rotation was what
    # made the list feel random, and a row whose position changes is a row he has to read again.
    return rows


_artifacts_load()


def _turns_from_history(hist):
    """Pair a window's flat message list into turns. A question with no answer is kept: a conversation
    that ended mid-sentence is still a conversation, and hiding the last thing he asked would be a lie."""
    turns, pending = [], None
    for m in hist or []:
        role = m.get("role") if isinstance(m, dict) else None
        if role == "user":
            if pending and pending.get("q"):
                turns.append(pending)
            pending = {"q": str(m.get("content") or ""), "a": "", "t": float(m.get("at") or 0)}
        elif role == "assistant" and pending:
            pending["a"] = str(m.get("content") or "")
    if pending and pending.get("q"):
        turns.append(pending)
    return turns


def _session_key():
    """The name of the window he is in. Before the first rotation no id has been minted, and every
    path that names the live window has to agree on what to call it: two placeholders for the same
    empty value turned one conversation into two records, one under "current" and one under "unknown"."""
    if not SESSION.get("id"):
        # A window with no name filed its turns under the literal "current", and the next window's turns
        # joined them: one record holding two conversations, and the same answer stored twice under two
        # names. A name is minted the first time a window needs one, so every record has its own.
        try:
            SESSION["id"] = uuid.uuid4().hex
        except Exception:
            return "current"
    return SESSION["id"]


def concise_title(q, limit=25):
    """The gist of a request, for a list a person reads rather than a sentence to be parsed.

    A spoken request opens with padding — "hey jarvis", "can you", "please" — and a raw first line
    then either repeats that padding in the drawer or gets cut mid-word at the row's own width.
    Both are the same fault: the row is showing the first sentence instead of the subject. This
    strips the padding, removes the trailing punctuation nobody reads aloud, and cuts at a word
    boundary. It is one rule applied in one place, so the row a page shows before a conversation
    is saved cannot disagree with the row the machine stores afterwards.
    """
    pad = ("hey jarvis", "hi jarvis", "ok jarvis", "okay jarvis", "jarvis",
           "can you", "could you", "would you", "can u", "could u", "please",
           "i want you to", "i need you to", "i'd like you to")
    t = " ".join(str(q or "").split())
    low = t.lower()
    again = True
    while again:
        again = False
        for p in pad:
            if low == p or low.startswith(p + " "):
                t = t[len(p):].lstrip(" ,.:;-")
                low = t.lower()
                again = True
                break
    t = t.strip(" ,.:;-\u2013\u2014")
    if not t:
        return ""
    if len(t) > limit:
        cut = t[:limit + 1]
        if " " in cut:
            cut = cut[:cut.rindex(" ")]
        t = cut.strip(" ,.:;-\u2013\u2014") or t[:limit]
    return t[:1].upper() + t[1:]


def _clean_steps(raw):
    """The work trace that belongs to a turn, bounded so a conversation stays a conversation.

    What the page sends is what it showed him while the answer was being written: the tools it
    reached for, the files it read, the lines it was working on. It belongs with the turn, or a
    conversation opened tomorrow loses the reason the answer looks the way it does. It is bounded
    because this is the one part of a turn whose length the machine chooses: the words on the rows
    only — nothing here opens a raw call any more — at eighty rows and two hundred characters each.
    """
    if not isinstance(raw, list):
        return []
    out = []
    for it in raw[-80:]:
        if not isinstance(it, dict):
            continue
        kind = str(it.get("kind") or "tool")[:24]
        one: dict = {"kind": kind}
        if kind == "note":
            text = str(it.get("text") or "")[:200]
            if not text:
                continue
            one["text"] = text
        else:
            title = str(it.get("title") or "")[:200]
            tool = str(it.get("tool") or "")[:40]
            if not (title or tool):
                continue
            one["title"] = title
            one["tool"] = tool
            one["ok"] = it.get("ok") is not False
            if isinstance(it.get("ms"), (int, float)):
                one["ms"] = int(it.get("ms"))
            kids = it.get("kids")
            if isinstance(kids, list) and kids:
                one["kids"] = [str(k or "")[:200] for k in kids[:3]]
        out.append(one)
    # A repeated step is one step that happened more than once. Filed as separate rows it read as
    # eleven different things having been done.
    folded: list = []
    for one in out:
        key = str(one.get("title") or "")
        if folded and key and key == str(folded[-1].get("title") or ""):
            folded[-1]["n"] = int(folded[-1].get("n") or 1) + 1
            continue
        folded.append(one)
    return folded


def _ensure_turn_ids(sid, turns):
    """Every turn the machine hands out carries a name.

    A turn written before ids existed, or one the agent's own window kept (it stores words, never
    ids), would otherwise reach the page unnamed — and the page, needing something to hang a block
    on, invented its own. Two names for one turn is exactly the drift this whole contract removes.
    The name is derived from the turn itself (conversation, question, its own instant), so the same
    turn gets the same name on every read and no persistence is needed to keep it.
    """
    if not turns:
        return turns
    import hashlib
    for t in turns:
        if not isinstance(t, dict):
            continue
        tid = str(t.get("tid") or "").strip()
        if re.fullmatch(r"[0-9a-f]{8,40}", tid):
            continue
        seed = "%s|w|%s|%s" % (str(sid or ""), str(t.get("q") or ""), str(t.get("t") or t.get("at") or ""))
        t["tid"] = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]
    return turns


def _merge_traces(turns, saved):
    """Put the page's work trace back onto the turns of the agent's own window.

    The agent's history is a list of messages: it has the words and nothing else. The work trace is
    what the page showed him while those words were being written, and it lives with the copy the page
    saved. The two records meet on the question and nothing else: the page's clock is the moment a turn
    finished on the device, the machine's is the moment it recorded the question, and they never agree
    — so pairing them by timestamp silently stripped the trace off every turn it was meant to restore,
    which is the same as not carrying it at all. Pairing in order on the question text keeps a trace
    with the words it belongs to, and a turn that was never saved is left alone rather than handed
    someone else's work.
    """
    if not turns or not saved:
        return turns
    pool = [s for s in saved if isinstance(s, dict)]
    used = set()
    for t in turns:
        if not isinstance(t, dict):
            continue
        q = str(t.get("q") or "")
        for i, s in enumerate(pool):
            if i in used or str(s.get("q") or "") != q:
                continue
            used.add(i)
            # The page's copy is also where a turn's own id lives: the agent's window is a list of
            # words and carries no ids at all. Without this the same conversation read back through
            # the live window lost every turn id, and a page could not match what it was showing to
            # what the machine had. The words are the key; the id travels with them.
            for k in ("s", "w", "tid", "ms", "startedAt"):
                if s.get(k) and not t.get(k):
                    t[k] = s[k]
            break
    return turns


TITLE_TRIED = set()          # conversations already asked to be named
# Its own lock, never SESSIONS_LOCK: the namer is called from the thread that is already holding the
# record lock, and a plain lock taken twice by one thread does not wait, it stops — the turn's caller
# hung on the request that was meant to name it.
TITLE_LOCK = threading.RLock()  # reentrant: a helper that takes this lock must be callable while it is held
TITLE_SYSTEM = ("You name conversations. Given a request and the answer to it, reply with a title of "
                "three to five words naming what the conversation is ABOUT — its subject, not the "
                "wording of the request. Title case. No quotes, no full stop, no emoji, and never the "
                "words chat, session or conversation. Reply with the title alone.")


def _ai_title(question, answer):
    """A name for a conversation, from what it turned out to be about."""
    try:
        body = json.dumps({"model": FRONT_MODEL, "stream": False, "max_tokens": 60,
                           "thinking": {"type": "disabled"},
                           "messages": [{"role": "system", "content": TITLE_SYSTEM},
                                        {"role": "user",
                                         "content": "Request: %s\n\nAnswer: %s"
                                                    % (str(question)[:700], str(answer or "")[:1400])}]}).encode()
        req = urllib.request.Request("https://api.deepseek.com/chat/completions", data=body,
                                     headers={"Content-Type": "application/json",
                                              "Authorization": "Bearer " + DS_KEY})
        with urllib.request.urlopen(req, timeout=25) as resp:
            txt = json.loads(resp.read())["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print("title: could not be made: %s" % e, flush=True)
        return ""
    raw = txt
    txt = re.sub(r"\s+", " ", txt).strip().strip('"\'').strip()
    # A model asked for a title sometimes labels it ("Title: X") or opens a line with a bullet.
    txt = re.sub(r"^\s*(?:title|name|chat)\s*[:\-]\s*", "", txt, flags=re.I).strip()
    txt = re.sub(r"^[\-•*\d.\s]+", "", txt).strip().strip('"\'').strip()
    txt = re.sub(r"[.;:,!]+$", "", txt).strip()
    # A name that is a sentence, a refusal or the word "untitled" is not a name: the first prompt stays in
    # its place rather than a worse label, because a wrong name is a chat he cannot find again. Every
    # rejection says so out loud — a namer that fails silently is one nobody can debug, and this one was
    # measured returning nothing at all with a perfectly good reply in hand.
    if not txt:
        print("title: empty reply (%r)" % raw[:60], flush=True)
        return ""
    if len(txt) > 64 or len(txt.split()) > 8:
        print("title: too long, kept out: %r" % txt[:80], flush=True)
        return ""
    if txt.lower() in ("untitled", "new chat", "chat", "session", "conversation"):
        print("title: not a name: %r" % txt[:60], flush=True)
        return ""
    if NO_CAPABILITY.search(txt):
        print("title: claimed a limit, dropped: %r" % txt[:80], flush=True)
        return ""
    return txt


def name_conversation(conv, question, answer):
    """Name the conversation in the background, once, after its first answer exists.

    The first eighty characters of a request name the request, not the thread: three conversations
    about the same machine all read the same, and he cannot tell them apart in the drawer.
    """
    if PAGE_TEXT.owns(str(conv)):
        return
    if not (conv and DS_KEY):
        return
    # A conversation is only marked as attempted once its name is actually stored. Marking it before the
    # call meant one miss — the record not yet written, a timing-out model — cost that chat its name for
    # the life of the process, and the drawer fell back to the raw first question ("Hello") for ever.
    try:
        with TITLE_LOCK:
            if conv in TITLE_TRIED:
                return
    except Exception:
        return
    print("title: asked for %s" % str(conv)[:8], flush=True)

    # Made here, on the thread that is already finishing the turn, rather than handed to a worker thread: the
    # call is measured at about a second, the answer is already with him, and a namer that runs on its own
    # thread was observed asking for the name and then never reaching the call at all.
    try:
        title = _ai_title(question, answer)
    except Exception as e:
        print("title: could not be made: %s" % e, flush=True)
        return
    if not title:
        return
    try:
        with SESSIONS_LOCK:
            rec = SESSIONS.get(conv)
            if not isinstance(rec, dict) or rec.get("named"):
                return
            rec["title"] = title
            rec["named"] = True
        _sessions_save()
        try:
            with TITLE_LOCK:
                TITLE_TRIED.add(conv)
        except Exception:
            pass
    except Exception as e:
        print("title: could not be saved: %s" % e, flush=True)
        return
    # Anyone reading this conversation is told at once, so the row renames itself without a reload.
    try:
        # _live_turn_for takes LIVE_LOCK itself. Calling it while holding the lock deadlocked this thread
        # on a non-reentrant lock, and the lock then stayed held for good - which froze every reader of
        # the session list, so the drawer came up empty. Never nest them.
        tid = _live_turn_for(conv)
        with LIVE_LOCK:
            chan2 = LIVE_TURNS.get(tid) if tid else None
        if chan2:
            chan2.publish("title", {"conv": conv, "title": title})
    except Exception:
        pass
    print("title: %s -> %s" % (conv[:8], title), flush=True)


def _session_title(turns):
    for t in turns or []:
        q = (t.get("q") or "").strip()
        if q:
            return concise_title(q) or q[:80] or "Untitled"
    return "Untitled"


def _purge_stamp():
    """When this page's history was last emptied, as the page can read it."""
    try:
        with open(PURGE_FILE, encoding="utf-8") as f:
            return float(json.load(f).get("purged") or 0)
    except Exception:
        return 0.0


def _mark_purged():
    """Stamp the purge so every device clears its own copy the next time it looks."""
    try:
        tmp = PURGE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"purged": time.time()}, f)
        os.replace(tmp, PURGE_FILE)
        return _purge_stamp()
    except Exception as e:
        print("purge stamp could not be written: %r" % (e,))
        return 0.0


def _sessions_load():
    try:
        with open(SESSIONS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for sid, s in data.items():
                if isinstance(s, dict) and isinstance(s.get("turns"), list):
                    SESSIONS[str(sid)] = {
                        "id": str(sid),
                        "title": str(s.get("title") or "Untitled"),
                        "started": float(s.get("started") or 0),
                        "updated": float(s.get("updated") or 0),
                        "turns": s["turns"],
                    }
    except Exception:
        pass


def _sessions_save():
    """Atomic, like the window's own history: a kill mid-write must not leave half a conversation."""
    try:
        ordered = sorted(SESSIONS.values(), key=lambda s: -(s.get("updated") or 0))[:SESSIONS_MAX]
        payload = {s["id"]: s for s in ordered}
        tmp = SESSIONS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp, SESSIONS_FILE)
        for sid in list(SESSIONS):
            if sid not in payload:
                SESSIONS.pop(sid, None)
    except Exception:
        pass


def _turn_key(t):
    """The identity of one turn.

    Three things can name the same turn: the machine numbers it, the page learns that number, and each
    side writes its own record with its own idea of when the turn began. The key used to be the id, or
    question and start time — and the two writers' start times differ by a second, so one turn was filed
    twice and painted twice. The number the machine gives the turn is the one thing both writers agree
    on, so it leads; then the id; then question and start time for turns recorded before either existed.
    """
    srv = str(t.get("srv") or t.get("turn") or "").strip()
    if srv:
        try:
            return ("srv", str(int(float(srv))))
        except Exception:
            return ("srv", srv)
    tid = str(t.get("tid") or "").strip()
    if tid:
        return ("tid", tid)
    q = str(t.get("q") or "")
    started = t.get("startedAt")
    if started:
        try:
            return ("qs", q, int(float(started)))
        except Exception:
            return ("qs", q, str(started))
    return ("qt", q, str(t.get("t") or ""))



def _turn_tid(conv, n):
    """The name of one turn, minted here.

    This helper went missing when the turn key was rewritten beside it: the open event called a name that
    no longer existed, the stream died on its first event, and every turn after that produced an answer
    the page never received.
    """
    import hashlib
    return hashlib.sha1(("%s|%s" % (str(conv or ""), str(n or ""))).encode("utf-8")).hexdigest()[:16]


def _dedupe_turns(turns):
    """One exchange is one turn, whichever side wrote it down.

    The page files a turn when it finishes; the machine files the same turn as it runs. Different ids,
    times a fraction apart, answers that differ at the tail. Read back they were two questions and two
    answers, which is what he saw when he scrolled up. Identity is the question plus the opening of the
    answer; the richer copy wins.
    """
    out, seen = [], {}
    for t in (turns or []):
        if not isinstance(t, dict):
            continue
        q = " ".join(str(t.get("q") or "").split())[:400]
        a = " ".join(str(t.get("a") or "").split())[:80]
        if not q:
            out.append(t)
            continue
        k = (q, a)
        prev = seen.get(k)
        if prev is None:
            seen[k] = t
            out.append(t)
            continue
        if len(str(t.get("a") or "")) > len(str(prev.get("a") or "")):
            prev["a"] = t["a"]
        if not prev.get("tid") and t.get("tid"):
            prev["tid"] = t["tid"]
        if not prev.get("t"):
            prev["t"] = t.get("t")
        if int(t.get("ms") or 0) > int(prev.get("ms") or 0):
            prev["ms"] = t.get("ms")
        if len(t.get("s") or []) > len(prev.get("s") or []):
            prev["s"] = t.get("s")
    return out


def _merge_turns(saved, incoming):
    """Union two records of the same conversation.

    The page's copy and the machine's copy are the same conversation written from two sides: the page
    has the work traces and whatever it drew, the machine has the answers its own window kept after the
    page had gone. Replacing one with the other loses turns whichever way round it is done — a save
    from an older tab would delete an answer the machine kept, and the machine's copy has no traces at
    all — so a save is a union, matched on the turn's own id, in time order, with the trace kept when either
    side has one. Two turns that share a question but not an answer are two turns: nothing is collapsed.
    """
    out = [dict(t) for t in (saved or []) if isinstance(t, dict)]
    for t in (incoming or []):
        if not isinstance(t, dict):
            continue
        q = str(t.get("q") or "")
        # A turn is identified by its own id, not by the words of the question. Matching on the question
        # collapsed two genuine asks of the same thing into one bubble and refreshed the first answer out
        # of existence. A turn with no id (written before ids existed) falls back to question plus answer,
        # which is still the same turn however often it is saved.
        mine = _turn_key(t)
        hit = None
        for cur in out:
            if _turn_key(cur) == mine:
                hit = cur
                break
        if hit is None:
            ta = str(t.get("a") or "")
            if ta and any(str(c.get("a") or "") == ta for c in out if str(c.get("q") or "") != q):
                continue            # an answer this record already holds under another question
            out.append(dict(t))
            continue
        if not hit.get("a") and t.get("a"):
            hit["a"] = t["a"]
        for k in ("s", "w"):
            if t.get(k) and not hit.get(k):
                hit[k] = t[k]
        hit["t"] = max(float(hit.get("t") or 0), float(t.get("t") or 0)) or hit.get("t")
    out.sort(key=lambda x: float(x.get("t") or 0))
    del out[:-200]
    # One question with one answer is one turn. The page and the machine both file a turn and their
    # start times can land a second apart, so the key misses and the same exchange is stored twice -
    # identical question, identical answer, painted twice on reopen. The key carries the turn's own id,
    # so only the same turn written twice collapses: two questions that happen to read the same and
    # produce the same first paragraph keep their own rows.
    # The page files a turn when it finishes and the machine files the same turn as it runs, so the two
    # copies carry different ids, slightly different times, and answers that differ at the tail because
    # one was captured while it was still being written. Matching on the id therefore found nothing and
    # the same exchange appeared twice. The words are what identify it: the same question and an answer
    # that starts the same is the same turn, whichever side wrote it.
    def _norm(x, n):
        return " ".join(str(x or "").split())[:n]

    _seen = {}
    _out = []
    for _t in out:
        _q = _norm(_t.get("q"), 400)
        _a = _norm(_t.get("a"), 80)
        if not _q:
            _out.append(_t)
            continue
        _k = (_q, _a)
        _prev = _seen.get(_k)
        if _prev is None:
            _seen[_k] = _t
            _out.append(_t)
            continue
        # Keep the richer copy: the one with an id, the longer answer, more steps, a real duration.
        if not _prev.get("tid") and _t.get("tid"):
            _prev["tid"] = _t["tid"]
        if len(str(_t.get("a") or "")) > len(str(_prev.get("a") or "")):
            _prev["a"] = _t["a"]
        if not _prev.get("t"):
            _prev["t"] = _t.get("t")
        if int(_t.get("ms") or 0) > int(_prev.get("ms") or 0):
            _prev["ms"] = _t.get("ms")
        if len(_t.get("s") or []) > len(_prev.get("s") or []):
            _prev["s"] = _t.get("s")

    return _out

def _touch_conversation(conv, q):
    """Make sure a conversation has a record, without inventing a turn. Returns True when it was made here."""
    conv = str(conv or "").strip()
    if not re.fullmatch(r"[0-9a-fA-F]{8,40}", conv or ""):
        return False
    if tombstoned(conv):
        return False
    now = time.time()
    with SESSIONS_LOCK:
        if conv in SESSIONS:
            return False
        SESSIONS[conv] = {"id": conv, "title": concise_title(q) or "Untitled",
                          "started": now, "updated": now, "turns": []}
    _sessions_save()
    return True


def _drop_empty_conversation(conv):
    """A turn that produced nothing leaves no chat behind: the row would hold a question with no answer."""
    conv = str(conv or "").strip()
    if not conv:
        return
    with SESSIONS_LOCK:
        rec = SESSIONS.get(conv)
        if not isinstance(rec, dict) or (rec.get("turns") or []):
            return
        SESSIONS.pop(conv, None)
    _sessions_save()
    print("conversation %s dropped: its only turn produced nothing" % conv[:8])


def _session_keep_turn(conv, q, a, ms=None, steps=None, started_at=None):
    """Write one finished turn into the record of the conversation it was asked in.

    Used when the live window has already moved on: he started a new chat, or the window timed out,
    while the answer was still being produced. The answer he asked for is still his, and the record of
    the conversation he asked it in is where it belongs — not in the window that has replaced it, where
    it would read as an answer to someone else's question.
    """
    conv = str(conv or "current")
    now = time.time()
    q = _redact.redact(q or "")          # a secret never reaches the store
    a = _redact.redact(a or "")
    steps = [_redact.redact(str(x)) for x in (steps or [])]
    if tombstoned(conv):
        print("turn for deleted conversation %s not filed" % conv)
        return
    with SESSIONS_LOCK:
        if tombstoned(conv):
            return
        entry = SESSIONS.get(conv) or {"id": conv, "title": concise_title(q) or "Untitled",
                                       "started": now, "updated": now, "turns": []}
        turns = list(entry.get("turns") or [])
        # The same question in the same conversation is one turn. Its answer is refreshed where it stands
        # rather than a second identical row being added beside it.
        same = [t for t in turns if str(t.get("q") or "") == str(q or "")]
        last = same[0] if same else None
        if last is not None:
            last["a"] = a
            last["t"] = now
            if ms:
                last["ms"] = int(ms)
            if started_at:
                last["startedAt"] = float(started_at)
            if steps:
                last["s"] = [{"label": str(x)[:160]} for x in steps]
        elif not any(str(t.get("q") or "") == str(q or "") and str(t.get("a") or "") == str(a or "")
                     for t in turns):
            # The duration travels with the turn. A conversation opened later has no clock of its own for a
            # turn that ran while he was elsewhere, so a badge or a summary built from the canvas showed 0s
            # for work that took a minute — the number has to come from where the work happened.
            entry_turn = {"q": str(q or ""), "a": str(a or ""), "t": now}
            # When the turn began, as a wall-clock stamp. A duration alone cannot be counted down or up on a
            # screen that arrives late; with the start time the elapsed is arithmetic on two absolute numbers,
            # so a chat reopened from the drawer shows the true duration instead of starting again at zero.
            if started_at:
                entry_turn["startedAt"] = float(started_at)
            if ms:
                entry_turn["ms"] = int(ms)
            if steps:
                entry_turn["s"] = [{"label": str(x)[:160]} for x in steps]
            turns.append(entry_turn)
        # A duration that arrives later (the page's own copy is written after the machine's) is kept: the
        # record only ever gets fuller.
        if ms or steps or started_at:
            for t in turns:
                if str(t.get("q") or "") != str(q or ""):
                    continue
                if started_at and not t.get("startedAt"):
                    t["startedAt"] = float(started_at)
                if ms and not t.get("ms"):
                    t["ms"] = int(ms)
                if steps and not t.get("s"):
                    t["s"] = [{"label": str(x)[:160]} for x in steps]
        entry.update({"turns": turns[-200:], "updated": now})
        SESSIONS[conv] = entry
        _sessions_save()
    print("kept one turn with %s: %d turn(s)" % (conv[:12], len(turns)))
    # The name is asked for once, outside the record lock, and it lands whenever the model replies.
    name_conversation(conv, q, a)


def archive_session(sid=None):
    """Keep the window that is closing.

    Called from new_session() with HISTORY_LOCK already held, so it reads the history directly and
    never takes that lock itself: two of them in the wrong order is a deadlock, and this runs on the
    path that resets a conversation.
    """
    turns = _turns_from_history(HISTORY)
    if not turns:
        return
    key = sid or _session_key()
    now = time.time()
    with SESSIONS_LOCK:
        old = SESSIONS.get(key) or {}
        SESSIONS[key] = {
            "id": key,
            "title": _session_title(turns) or old.get("title") or "Untitled",
            "started": old.get("started") or (turns[0].get("t") or now),
            "updated": turns[-1].get("t") or now,
            # A window that is closing takes the trace the page recorded for it with it, rather than
            # replacing it with the agent's words-only record: the two are united.
            "turns": _merge_turns(old.get("turns"), turns),
        }
        _sessions_save()


_sessions_load()
TOMBSTONES.update(_tombstones_read())
print("tombstones: %d deleted conversation(s) remembered" % len(TOMBSTONES))
try:
    _r, _k = prune_backups()
    if _r:
        print("backups: %d copy(ies) older than %d days removed, %d kept"
              % (_r, backup_retention_days(), _k))
except Exception as _e:
    print("backups: prune skipped: %r" % (_e,))

# Read the stored conversation after every definition it can reach: an expired window is archived
# into the session store on the way through, so both that store and archive_session have to exist.
LOADED = _load_history()


@app.get("/suggest")
def suggest(request: Request):
    """The landing rows for a new session, from the machine's own state rather than a fixed list.

    The page asks on landing and after a new conversation. Cheap enough to answer on every landing:
    nothing is generated, and the rules only read numbers already collected for the telemetry page,
    the newest project and the newest script on the box, and the hour. Each row says whether it is
    the whole request (sent as it stands) or only the opening of one (handed to the box to finish).
    """
    if not _guard(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        chips = _suggest_chips()
    except Exception as e:
        print("suggest: %r" % (e,))
        return JSONResponse({"ok": False, "error": str(e)[:160], "chips": []})
    return JSONResponse({"ok": True, "chips": chips})


@app.post("/api/artifacts/code")
async def api_artifacts_code(request: Request):
    """Index the code an answer carried, so it is still findable after the conversation scrolls away.

    The page posts the finished answer; this pulls out the fenced blocks (and an answer that is a
    payload all by itself), keeps one copy of each distinct snippet, and returns what it added. The
    text is NOT returned: the page already has it, and the drawer fetches a document only when he
    taps its row.
    """
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "bad body"}, status_code=400)
    text = body.get("text") if isinstance(body, dict) else None
    if not isinstance(text, str) or not text.strip():
        return JSONResponse({"ok": False, "error": "nothing to index"}, status_code=400)
    title = str(body.get("title") or "").strip()[:80]
    blocks = _code_blocks(text)
    added, now = [], time.time()
    with ARTIFACT_LOCK:
        for b in blocks:
            aid = hashlib.sha1(("%s\n%s" % (b["lang"], b["text"])).encode("utf-8")).hexdigest()[:12]
            if aid in ARTIFACT_INDEX:
                # Seen again: it keeps its id, moves to the top, and remembers the newer question.
                ARTIFACT_INDEX[aid]["created"] = now
                if title:
                    ARTIFACT_INDEX[aid]["from"] = title
                continue
            ARTIFACT_INDEX[aid] = {"id": aid, "kind": "code", "created": now, "lang": b["lang"],
                                   "label": b["label"], "bytes": len(b["text"].encode("utf-8")),
                                   "from": title, "text": b["text"]}
            added.append({"id": aid, "lang": b["lang"], "label": b["label"],
                          "bytes": len(b["text"].encode("utf-8"))})
        if blocks:
            _artifact_save()
    if added:
        print("artifacts: indexed %d snippet(s), %d in the index" % (len(added), len(ARTIFACT_INDEX)))
    return JSONResponse({"ok": True, "added": added, "indexed": len(ARTIFACT_INDEX)})


@app.get("/api/artifacts")
def api_artifacts(request: Request):
    """Every indexed snippet, newest first, without the text: the drawer lists these."""
    if not _guard(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    with ARTIFACT_LOCK:
        rows = [{"id": a["id"], "kind": a.get("kind") or "code", "created": a.get("created") or 0,
                 "lang": a.get("lang") or "text", "label": a.get("label") or "",
                 "bytes": a.get("bytes") or 0, "from": a.get("from") or ""}
                for a in ARTIFACT_INDEX.values()]
    rows.sort(key=lambda r: -(r["created"] or 0))
    return JSONResponse({"ok": True, "artifacts": rows})


@app.get("/api/artifacts/{aid}")
def api_artifact(request: Request, aid: str):
    """One snippet, with its text, for the panel that opens it and the button that copies it."""
    if not _guard(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    with ARTIFACT_LOCK:
        a = ARTIFACT_INDEX.get(aid)
        if not a:
            return JSONResponse({"ok": False, "error": "not found"}, status_code=404)
        out = dict(a)
    return JSONResponse({"ok": True, "artifact": out})


@app.get("/api/sessions/status")
def sessions_status(request: Request):
    """What is actually happening, per conversation, without a socket.

    A reader can die mid-turn — the phone sleeps, the tunnel drops, the app is backgrounded — and the page is
    then left showing a ring for work that finished minutes ago. This answers from the machine's own registry,
    so a ring can always be settled against the truth rather than against a connection that has gone.
    """
    if not authed(request) or not same_origin(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    now = time.time()
    live = {}
    with LIVE_LOCK:
        for tid, reg in LIVE_TURNS.items():
            conv = reg.get("conv") if isinstance(reg, dict) else None
            if conv:
                live[str(conv)] = True
    out = []
    with SESSIONS_LOCK:
        for sid, rec in SESSIONS.items():
            if not isinstance(rec, dict):
                continue
            turns = rec.get("turns") or []
            newest = turns[-1] if turns else {}
            running = str(sid) in live
            if running:
                state = "running"
            elif str(newest.get("a") or "").strip():
                state = "completed"
            elif newest:
                state = "failed"
            else:
                state = "empty"
            out.append({"id": sid, "state": state, "updated": rec.get("updated") or 0,
                        "title": rec.get("title") or "", "named": bool(rec.get("named")),
                        "turns": len(turns),
                        "startedAt": newest.get("startedAt") or 0,
                        "ms": newest.get("ms") or 0,
                        "elapsed": int(now - float(newest.get("startedAt") or now)) if running else 0})
    return JSONResponse({"ok": True, "at": now, "sessions": out, "running": list(live.keys())})


@app.get("/api/sessions")
def api_sessions(request: Request):
    """Every conversation kept, newest first, with the one he is in at the top when it has anything in it."""
    if not _guard(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    PAGE_TEXT.overlay_history()
    now = time.time()
    live_id = _session_key()
    with SESSIONS_LOCK:
        out = [{"id": s["id"], "title": s["title"], "started": s["started"], "updated": s["updated"],
                "turns": len(s["turns"]), "live": False, "pinned": bool(s.get("pinned")),
                "named": bool(s.get("named"))} for s in SESSIONS.values()]
    # Which chats are being answered right now, named per row. Only the window he was in used to carry
    # this, so the drawer's working ring could only ever light on the row he had tapped.
    for _o in out:
        try:
            _o["turn"] = _live_turn_for(_o["id"])
            _o["turn_q"] = _live_question_for(_o["id"])
        except Exception:
            _o["turn"] = None
    with HISTORY_LOCK:
        live_turns = _turns_from_history(HISTORY)
    if live_turns:
        out = [o for o in out if o["id"] != live_id]
        # The row for the window he is in, named from its turns. When the only turn in it is still being
        # written the committed turns say nothing, and the question the machine is answering is the name
        # this conversation actually has: a row reading "Untitled" is a chat he cannot recognise.
        live_title = _session_title(live_turns)
        if live_title == "Untitled":
            live_title = concise_title(_live_question_for(live_id)) or live_title
        # The namer may already have given this conversation its own name; a row still showing the raw
        # first question beside a record that has a name reads as two different chats.
        with SESSIONS_LOCK:
            _rec = SESSIONS.get(live_id)
            if isinstance(_rec, dict) and _rec.get("named") and _rec.get("title"):
                live_title = str(_rec["title"])
        # A row's place in the drawer is when the conversation last MOVED, not when it was last opened.
        # Falling back to `now` here put whichever chat he had just pressed at the top of the list, so the
        # order changed under his thumb every time he looked at something old.
        _lrec = SESSIONS.get(live_id)
        _lrec = _lrec if isinstance(_lrec, dict) else {}
        _lupd = live_turns[-1].get("t") or _lrec.get("updated") or now
        # When it STARTED, because that is what fixes its place in the drawer. A conversation with no
        # record yet takes its first turn's moment; nothing here may move an existing row.
        _lstart = _lrec.get("started") or live_turns[0].get("t") or _lupd
        out.append({"id": live_id, "title": live_title,
                    "started": _lstart,
                    "updated": _lupd,
                    "turns": len(live_turns), "live": True,
                    "pinned": bool((SESSIONS.get(live_id) or {}).get("pinned")) if isinstance(SESSIONS.get(live_id), dict) else False,
                    "turn": _live_turn_for(live_id),
                     "turn_q": _live_question_for(live_id), "turn_started": _live_started_for(live_id),
                     "turn_tid": _live_tid_for(live_id)})
    # A conversation whose first answer is still being written has nothing stored yet, and leaving it out
    # of the list left him unable to get back to it: the one conversation with work in flight was the one
    # the drawer did not show. The turns still running are listed from their own questions, with no turns
    # committed, which is exactly what they are.
    known = {str(o.get("id")) for o in out}
    with LIVE_LOCK:
        running = [(int(t), str((LIVE_TURNS[t] or {}).get("conv") or "")) for t in sorted(LIVE_TURNS)]
    for t, conv in running:
        if not conv or conv in known:
            continue
        with TURN_CHANS_LOCK:
            chan = TURN_CHANS.get(t)
        q = chan.question if chan else ""
        out.append({"id": conv, "title": concise_title(q) or "New conversation", "running": True,
                    "started": (chan.started if chan else now), "updated": now,
                    "turns": 0, "live": conv == live_id, "turn": t})
        known.add(conv)
    # Newest chat first, and nothing else moves. See the note in static/v1.js: order is creation, not activity.
    out.sort(key=lambda s: -(s.get("started") or 0))
    return JSONResponse({"ok": True, "sessions": out[:80], "now": now, "live_id": live_id,
                         "purged": _purge_stamp()})


@app.post("/api/sessions/clear")
async def api_sessions_clear(request: Request):
    """Clear this page's whole chat history: the archived conversations and the window he is in.

    What it does NOT touch is the agent's own session store under ~/.hermes. That is the machine's
    record of work done, not this page's history, and it is not something a button in a drawer gets
    to delete. The reply carries what actually went, so the page can say it in numbers instead of
    claiming a clean sweep it cannot see.

    It refuses a bare POST. Knowing the URL is not the same as meaning it: the caller has to say what
    it is doing in the body, which means the request carries the intent of the tap that started it and
    not only the shape of one. A retry, a replayed request or a stray fetch arrives without that and
    is turned away, with a line in the log naming who tried.
    """
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict) or body.get("confirm") != CONFIRM_CLEAR:
        print("chat history clear REFUSED: no confirmation in the body (from %s, referer %s)"
              % (request.headers.get("user-agent", "unknown")[:60],
                 request.headers.get("referer", "none")[:60]))
        return JSONResponse({"ok": False, "error": "unconfirmed"}, status_code=400)
    # Freeze, then destroy (the operator's own protocol, and his rule about a delete: back it up,
    # say where it went, report what went and what stayed). A purge that cannot be undone is one
    # stray tap away from a loss, and this costs a few kilobytes.
    restore_to = ""
    try:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = os.path.join(HERE, "backups", "clear-" + stamp)
        os.makedirs(dest, exist_ok=True)
        for src in (SESSIONS_FILE, HISTORY_FILE):
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(dest, os.path.basename(src)))
        restore_to = dest
    except Exception as e:
        print("chat history clear: could not take a safety copy: %r" % (e,))
    with LIVE_LOCK:
        for victim in LIVE_TURNS.values():
            victim["yes"] = True
            tombstone_add(victim.get("conv"), backup=restore_to)
    # The window is closed FIRST and purged second, because closing it archives it: clearing first
    # would have left the conversation he was just in sitting in the archive he thought he emptied.
    with HISTORY_LOCK:
        TURN["n"] += 1                     # anything in flight can no longer commit
        TURN["by"].clear()
        live_turns = len(_turns_from_history(HISTORY))
        sid = close_session()              # archives the window, clears it, mints a clean session
        try:
            tmp = HISTORY_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump([], f)
            os.replace(tmp, HISTORY_FILE)
        except Exception:
            pass
    with SESSIONS_LOCK:
        gone = len(SESSIONS)
        gone_turns = sum(len(s.get("turns") or []) for s in SESSIONS.values())
        for conv, entry in SESSIONS.items():
            tombstone_add(conv, backup=restore_to, turns=len(entry.get("turns") or []))
        SESSIONS.clear()
        _sessions_save()
    purged = _mark_purged()
    # A new conversation takes the panel down with it, on the server as well as the page (see /reset).
    ART_SEQ[0] += 1
    broadcast_art({"kind": "clear", "seq": ART_SEQ[0], "purged": purged})
    print("chat history cleared: %d conversations, %d archived turns, %d live turns"
          " (from %s, referer %s, safety copy %s)"
          % (gone, gone_turns, live_turns, request.headers.get("user-agent", "unknown")[:48],
             request.headers.get("referer", "none")[:48], restore_to or "NOT TAKEN"))
    return JSONResponse({"ok": True, "sessions": gone, "turns": gone_turns + live_turns,
                         "live_turns": live_turns, "session": sid, "restore": restore_to,
                         "purged": purged})


# --- the account portal: identity, the bindings that exist, and the sessions holding access -----------
# Everything here is read from this node's own files at request time. A binding is "Bound" only because
# something is actually stored for it; where nothing is stored the page says so rather than showing a
# badge for a capability that is not there.


def _mail_channel():
    """The node's own mail identity, from its own channel directory.

    Returns (address, connected). The address is taken only from the directory entry that is the
    operator's own; the directory also lists other people who have written to him, and showing a
    customer's address in the account page would be both wrong and careless. When no entry can be
    attributed to him the channel is still reported as connected, with no address shown rather than a
    guessed one.
    """
    try:
        with open(os.path.join(HERMES, "channel_directory.json"), encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        return "", False
    mail = (d.get("platforms") or {}).get("email")
    if not mail:
        return "", False
    entries = mail if isinstance(mail, list) else [mail]
    for e in entries:
        if not isinstance(e, dict):
            continue
        addr = str(e.get("id") or e.get("address") or "")
        name = str(e.get("name") or "").strip().lower()
        if "@" in addr and name in ("batte", "mohammad", "home"):
            return addr, True
    return "", True


def _google_stored():
    """True only when this node really holds a Google credential.

    Checked by name, at the two paths a Google sign-in is stored at, and only by their own contents: a
    broader search of the tree matched model request dumps that merely mention the word, which reported a
    binding that was not there.
    """
    for p in (os.path.join(HERMES, "google_token.json"),
              os.path.join(HERMES, "google_client_secret.json")):
        try:
            with open(p, encoding="utf-8") as f:
                if "refresh_token" in f.read():
                    return True
        except Exception:
            continue
    return False


def _admin_wa_number():
    """The number this node treats as its owner, from the config's own admin list."""
    try:
        with open(os.path.join(HERMES, "config.yaml"), encoding="utf-8") as f:
            for line in f:
                if "allow_admin_from:" in line:
                    for item in line.split(":", 1)[1].split(","):
                        item = item.strip()
                        if item.endswith("@s.whatsapp.net"):
                            digits = item.split("@")[0]
                            return ("+" + digits) if digits.startswith("256") else digits
    except Exception:
        pass
    return ""


def _forget_device(tok):
    """Drop one device's token, keeping a copy of the file it came from.

    The file stores hashes, so the row is matched on the hash of the presented token as well as on
    the token itself (a legacy row written before hashing still matches by plaintext).
    """
    if not tok:
        return 0
    key, entry = (tok, device_entries().get(tok)) if _is_hash(tok) else device_lookup(tok)
    if entry is None:
        return 0
    try:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = os.path.join(HERE, "backups", "devices-" + stamp)
        os.makedirs(dest, exist_ok=True)
        shutil.copy2(DEVICES_FILE, os.path.join(dest, "jarvis_live_devices.txt"))
    except Exception as e:
        print("device revoke: no safety copy: %r" % (e,))
    gone = 0
    with DEVICES_LOCK:
        kept = []
        for line in device_lines():
            stored = line.split("\t")[0].strip() if line.strip() else ""
            if stored and stored in (tok, key, _tok_hash(tok)):
                gone += 1
                continue
            kept.append(line)
        if gone:
            _device_write([[x.strip() for x in ln.split("\t")] for ln in kept])
    if not gone:
        return 0
    print("device session forgotten: %s... (%d left)" % (tok[:6], len(device_entries())))
    return gone


@app.get("/api/account")
async def api_account(request: Request):
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    tok = cookie_token(request)
    stamp = os.path.join(HERMES, "jarvis_live_prune.stamp")
    try:
        last = os.path.getmtime(stamp)
    except Exception:
        last = 0
    if time.time() - last > 6 * 3600:
        prune_devices(reason="account page")
        try:
            open(stamp, "w").write(str(int(time.time())))
        except Exception:
            pass
    entries = device_entries()
    mine = entries.get(tok) or {}
    mail, mail_on = _mail_channel()
    google = _google_stored()
    phone = _admin_wa_number()
    mode = (_prefs().get("default_mode") or "voice")     # the machine's own preference store
    bindings = [
        {"id": "email", "label": "Email Address",
         "value": mail or ("mail channel connected" if mail_on else "not connected"),
         "status": "Bound" if mail_on else "Unbound", "primary": bool(mail_on)},
        {"id": "google", "label": "Google Account",
         "value": "credential stored on this node" if google else "no credential stored",
         "status": "Bound" if google else "Unbound", "primary": False},
        {"id": "phone", "label": "Phone Number", "value": phone or "not configured",
         "status": "Bound" if phone else "Unbound", "primary": False},
    ]
    devs = devices_summary(tok if tok in entries else None)
    acct = account_for("owner@example.com") or {}
    return JSONResponse({"ok": True, "name": acct.get("name") or "Mohammad",
                         "role": (acct.get("role") or "admin").title(), "bindings": bindings,
                         "this_device": {"label": device_display(mine.get("label") or device_key_for(
                                             request.headers.get("user-agent", ""))),
                                         "scope": mine.get("scope") or ("master" if not mine else "full"),
                                         "created": mine.get("created") or ""},
                         "devices": len(devs), "device_list": devs,
                         "sessions": len(entries),
                         "others": max(0, len(devs) - 1),
                         "account": {"id": acct.get("id") or "acc_owner",
                                     "email": "owner@example.com",
                                     "role": (acct.get("role") or "admin").title()},
                         "default_mode": mode})


@app.post("/api/account/logout")
async def api_account_logout(request: Request):
    """This device only: its token is forgotten and its cookie cleared, so the page comes back to the door."""
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    tok = cookie_token(request)
    gone = _forget_device(tok)
    out = JSONResponse({"ok": True, "forgot": gone, "left": len(device_entries())})
    try:
        out.delete_cookie(COOKIE)
    except Exception:
        pass
    return out


@app.post("/api/account/logout-all")
async def api_account_logout_all(request: Request):
    """Every OTHER device. The one asking keeps its access: a control that locks the hand pressing it is a
    trap, not a security control. dry=1 answers what it would revoke without revoking anything.
    """
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    tok = cookie_token(request)
    keep, _ = device_lookup(tok)
    others = [t for t in device_entries() if t != keep]
    body = {}
    try:
        body = await request.json()
    except Exception:
        body = {}
    if request.query_params.get("dry") or (isinstance(body, dict) and body.get("dry")):
        return JSONResponse({"ok": True, "dry": True, "would_revoke": len(others),
                             "this_device_kept": bool(keep)})
    if not isinstance(body, dict) or body.get("confirm") != CONFIRM_REVOKE:
        return JSONResponse({"ok": False, "error": "unconfirmed"}, status_code=400)
    revoked = 0
    for t in others:
        revoked += _forget_device(t)
    print("account: revoked %d other device sessions (asked from %s)" % (revoked, tok[:8] or "master"))
    return JSONResponse({"ok": True, "revoked": revoked, "left": len(device_entries())})


@app.delete("/api/sessions/{sid}")
async def api_session_delete(sid: str, request: Request):
    """Forget ONE kept conversation, from the drawer's own bin.

    Same discipline as clearing the lot: a safety copy first, then the removal, then a read-back of
    the store so the reply carries what actually went rather than what was asked for. The
    conversation he is in cannot be deleted here - it is not in the store, it is assembled from the
    live window - and saying so is better than pretending to succeed at it.
    """
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict) or body.get("confirm") != CONFIRM_FORGET:
        return JSONResponse({"ok": False, "error": "unconfirmed"}, status_code=400)
    if sid == _session_key():
        return JSONResponse({"ok": False, "error": "live"}, status_code=409)
    dest = ""
    try:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = os.path.join(HERE, "backups", "forget-" + stamp)
        os.makedirs(dest, exist_ok=True)
        if os.path.exists(SESSIONS_FILE):
            shutil.copy2(SESSIONS_FILE, os.path.join(dest, os.path.basename(SESSIONS_FILE)))
    except Exception as e:
        print("session forget: could not take a safety copy: %r" % (e,))
    with SESSIONS_LOCK:
        gone = SESSIONS.pop(sid, None)
        if gone is not None:
            _sessions_save()
        left = len(SESSIONS)
    if gone is None:
        return JSONResponse({"ok": False, "error": "not found", "left": left}, status_code=404)
    # The id is now remembered as gone, so a page that was offline, or a second device holding an
    # old copy, cannot bring it back by saving it or by asking a question in it.
    tombstone_add(sid, backup=dest, turns=len(gone.get("turns") or []))
    # The conversation is gone, so the work it was still doing goes with it. Left running it would
    # finish, write nothing (its writes are refused), and leave a child process burning a model call
    # for a chat that no longer exists.
    try:
        _cancel_conv(sid)
    except Exception as e:
        print("session forget: could not stop the turn in flight: %r" % (e,))
    try:
        prune_backups()
    except Exception as e:
        print("backups: prune after delete skipped: %r" % (e,))

    print("session forgotten: %s (%d turns), %d left, copy at %s"
          % (sid, len(gone.get("turns") or []), left, dest or "none"))
    return JSONResponse({"ok": True, "removed": sid, "turns": len(gone.get("turns") or []),
                         "left": left, "backup": dest})


@app.get("/api/sessions/{sid}")
def api_session(request: Request, sid: str):
    """One conversation, in order, for the canvas."""
    if not _guard(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    PAGE_TEXT.overlay_history()
    # A conversation that was deleted stays deleted, including from the page that deleted it: the turn
    # that was still running made this route answer as if the chat were simply mid-answer, and the chat
    # came back on the next open.
    if tombstoned(sid):
        return JSONResponse({"ok": False, "error": "no such conversation", "gone": True}, status_code=404)
    if sid == _session_key():
        with HISTORY_LOCK:
            live = _turns_from_history(HISTORY)
        # The window he is in has two records of itself: the one the machine keeps for the agent, capped
        # short so a prefill stays fast, and the one the page saves. They are the same conversation, so
        # the longer one is served — otherwise opening "now" showed less of it than the page already had.
        with SESSIONS_LOCK:
            saved = (SESSIONS.get(_session_key()) or {}).get("turns") or []
        turns = saved if len(saved) > len(live) else live
        # The agent's own window is a list of messages: it has the words and nothing else. The work
        # trace is what the page showed him while those words were being written, so the two records
        # are merged rather than chosen between — the longer list for the words, the saved one for the
        # trace. Without this, opening the window he is in from another device showed the answer with
        # its work stripped out.
        if turns is not saved:
            turns = _merge_traces(turns, saved)
        turns = _ensure_turn_ids(sid, _dedupe_turns(turns))
        # `turn` tells the page whether this conversation is a record or something still being
        # written: opening one that is mid-answer re-binds to the turn rather than reading a
        # half-finished record and calling the missing half a dropped link.
        return JSONResponse({"ok": True, "id": sid, "title": _session_title(turns), "turns": turns,
                             "turn": _live_turn_for(sid), "turn_q": _live_question_for(sid), "turn_started": _live_started_for(sid),
                             "turn_tid": _live_tid_for(sid)})
    with SESSIONS_LOCK:
        s = SESSIONS.get(sid)
    if not s:
        # Nothing stored under this name, but a turn is still working in it: that is a conversation whose
        # first answer has not been written yet, not a missing one. It is read as what it is — no turns,
        # and the turn to re-bind to — so opening it mid-answer shows the answer arriving.
        running = _live_turn_for(sid)
        if running is not None:
            # The turn's own name, question and start time travel with it here too. Without them this
            # branch — the first answer of a brand new chat, still being written — handed the page a
            # bare turn number and nothing to bind to, so opening that chat showed a question and no
            # work happening under it, which is the chat he came back to.
            return JSONResponse({"ok": True, "id": sid, "title": "New conversation",
                                 "turns": [], "turn": running,
                                 "turn_q": _live_question_for(sid),
                                 "turn_started": _live_started_for(sid),
                                 "turn_tid": _live_tid_for(sid)})
        return JSONResponse({"ok": False, "error": "no such conversation"}, status_code=404)
    return JSONResponse({"ok": True, "id": s["id"], "title": s["title"],
                         "turns": _ensure_turn_ids(sid, _dedupe_turns(s["turns"])),
                         "turn": _live_turn_for(sid), "turn_q": _live_question_for(sid), "turn_started": _live_started_for(sid),
                             "turn_tid": _live_tid_for(sid)})


@app.post("/api/sessions")
async def api_session_save(request: Request):
    _dbg_probe = True
    """The page's own copy of the thread it is showing, saved against the conversation it belongs to.

    The server is the record; this is the page saying "this is what I have", so a conversation is
    still there if the file behind it is ever lost. It writes the window he is in, not an archive.
    """
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "bad body"}, status_code=400)
    turns = body.get("turns") if isinstance(body, dict) else None
    if not isinstance(turns, list):
        return JSONResponse({"ok": False, "error": "no turns"}, status_code=400)
    clean = []
    for t in turns[:200]:
        if not isinstance(t, dict):
            continue
        q = str(t.get("q") or "")[:4000]
        a = str(t.get("a") or "")[:20000]
        if not (q or a):
            continue
        rec = {"q": q, "a": a, "t": float(t.get("t") or 0)}
        _tid = str(t.get("tid") or "").strip()
        if _tid and re.fullmatch(r"[0-9a-f]{8,40}", _tid):
            rec["tid"] = _tid
        try:
            if t.get("startedAt"):
                rec["startedAt"] = float(t.get("startedAt"))
        except Exception:
            pass
        # How long the turn took travels with it, from whichever record wrote it. A save from the page that
        # dropped this field left a conversation reporting seconds for work that took a minute.
        try:
            if t.get("ms"):
                rec["ms"] = int(t.get("ms"))
        except Exception:
            pass
        steps = _clean_steps(t.get("s"))
        if steps:
            rec["s"] = steps
        w = str(t.get("w") or "")[:400]
        if w.startswith("http"):
            rec["w"] = w
        # The conversation this turn was asked in, as the page knows it. Carried through the sanitiser so
        # the turn can be filed where it belongs rather than wherever the save happened to point.
        _cid = str(t.get("cid") or "").strip()
        if re.fullmatch(r"[0-9a-f]{32}", _cid):
            rec["_cid"] = _cid
        if isinstance(rec, dict):                 # a save carries text, so it carries secrets
            for f in ("q", "a"):
                if isinstance(rec.get(f), str):
                    rec[f] = _redact.redact(rec[f])
        clean.append(rec)
    if not clean:
        return JSONResponse({"ok": False, "error": "nothing to save"}, status_code=400)
    # A turn that finished while the page was looking at another conversation is saved against the
    # conversation it was asked in, so the page can say which one it means. A name that is not one of
    # ours is refused rather than trusted: this is a key into the store, not a label.
    want = str(body.get("id") or "").strip()
    if want and want != _session_key() and not re.fullmatch(r"[0-9a-f]{32}", want):
        return JSONResponse({"ok": False, "error": "bad conversation"}, status_code=400)
    # A save that names no conversation may only add to one that already exists under the machine's window
    # key. It must never bring a new record into being: that is how a finished answer appeared as a brand
    # new chat beside the chat it was asked in, with the same question inside it.
    if not want:
        _cids = {rec.get("_cid") for rec in clean if rec.get("_cid")}
        with SESSIONS_LOCK:
            _known = _session_key() in SESSIONS
        if not _cids and not _known:
            return JSONResponse({"ok": False, "error": "unnamed save"}, status_code=400)
    sid = want or _session_key()
    now = time.time()
    # Every turn goes to the conversation it was asked in. A save carries the page's history of one
    # conversation, and when the page did not know that conversation's name the whole history used to be
    # filed against whatever window the machine happened to be in — which is how a briefing's question
    # came to sit inside a machine-check record beside the machine-check answer, and how two
    # conversations about different things ended up sharing one name.
    groups: dict = {}
    for rec in clean:
        groups.setdefault(rec.pop("_cid", "") or sid, []).append(rec)
    last_key = sid
    with SESSIONS_LOCK:
        skipped = []
        for key, mine in groups.items():
            last_key = key
            if tombstoned(key):
                # Deleted, and the page still had a copy. It stays deleted.
                skipped.append(key)
                print("save refused: conversation %s was deleted" % key)
                continue
            old = SESSIONS.get(key) or {}
            if not old and key != _session_key():
                # A save may update a conversation; it may not bring one into being. Every chat is
                # created by its first turn, on the server, so an id the server has never seen is a
                # stale copy of something that is gone, and reviving it would put a ghost in the drawer.
                skipped.append(key)
                print("save refused: conversation %s is not one of ours" % key)
                continue
            united = _merge_turns(old.get("turns"), mine)
            title = (str(body.get("title") or "")[:80] if key == sid else "")
            if not title:
                # A conversation keeps the name it was given. Otherwise the name comes from the
                # conversation's own earliest question, never from whatever the payload began with.
                title = (str(old.get("title")) if old.get("named") and old.get("title")
                         else (_session_title(united) or old.get("title") or "Untitled"))
            entry = {"id": key, "title": title,
                     "started": old.get("started") or ((united[0].get("t") if united else now) or now),
                     "updated": ((united[-1].get("t") if united else now) or now),
                     "turns": united}
            if old.get("named"):
                entry["named"] = True
            # His own markings survive every save: a rename or a pin is not something a turn wipes.
            if old.get("pinned"):
                entry["pinned"] = True
            SESSIONS[key] = entry
        _sessions_save()
    # The name is asked for from here as well as from the machine's own filing: this is the path an ordinary
    # turn takes, and a conversation that is never named is one he cannot tell from its neighbour.
    try:
        if last_key not in skipped:
            last = clean[-1]
            name_conversation(last_key, last.get("q") or "", last.get("a") or "")
    except Exception as e:
        print("title: not asked: %s" % e, flush=True)
    return JSONResponse({"ok": True, "id": sid, "turns": len(clean), "skipped": skipped})


@app.post("/api/sessions/{sid}/meta")
async def session_meta(sid: str, request: Request):
    """The two things he can say about a conversation: its name, and whether it stays at the top.

    Neither touches when the conversation last moved. A rename that reordered the drawer would push
    the chat he just named above the one that just answered, which is not what a name means.
    """
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    if not re.fullmatch(r"[0-9a-fA-F]{32}", str(sid or "")):
        return JSONResponse({"ok": False, "error": "bad conversation"}, status_code=400)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "bad body"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"ok": False, "error": "bad body"}, status_code=400)
    with SESSIONS_LOCK:
        s = SESSIONS.get(sid)
        if not isinstance(s, dict):
            return JSONResponse({"ok": False, "error": "no such conversation"}, status_code=404)
        if "title" in body:
            name = " ".join(str(body.get("title") or "").split())[:60].strip()
            if not name:
                return JSONResponse({"ok": False, "error": "empty name"}, status_code=400)
            s["title"] = name
            s["named"] = True
        if "pinned" in body:
            s["pinned"] = bool(body.get("pinned"))
        _sessions_save()
        out = {"id": s.get("id"), "title": s.get("title"), "pinned": bool(s.get("pinned"))}
    return JSONResponse({"ok": True, "session": out})


import approvals as _approvals

_APPROVALS = {}

APPROVAL_LOCK = None
APPROVAL_SECRETS = {}
AUTO_ENABLED = os.environ.get("JARVIS_AUTO_APPROVE_ENABLED") == "1"


def approval_lock():
    global APPROVAL_LOCK
    if APPROVAL_LOCK is None:
        APPROVAL_LOCK = threading.RLock()
    return APPROVAL_LOCK


def approvals_store():
    # Built on first use: HERE is defined further down the module.
    with approval_lock():
        if "s" not in _APPROVALS:
            _APPROVALS["s"] = _approvals.Store(HERE)
        return _APPROVALS["s"]


def _internal_only(request: Request) -> bool:
    """The ask route is for a local child, never for anything the tunnel carried."""
    if request.headers.get("cf-connecting-ip"):
        return False
    peer = ""
    try:
        peer = request.client.host if request.client else ""
    except Exception:
        peer = ""
    return peer in ("127.0.0.1", "::1")


@app.post("/agent/ask")
async def agent_ask(request: Request):
    """A turn's child asks its own chat a question and waits for the answer."""
    if not _internal_only(request):
        return JSONResponse({"ok": False, "error": "not a local caller"}, status_code=403)
    secret = request.headers.get("x-turn-secret", "")
    try:
        body = await request.json()
    except Exception:
        body = {}
    conv = str((body or {}).get("conv") or "")
    turn = str((body or {}).get("turn") or "")
    with approval_lock():
        expect = APPROVAL_SECRETS.get((conv, turn))
        if not secret or not expect or not hmac.compare_digest(secret, expect):
            return JSONResponse({"ok": False, "error": "bad turn secret"}, status_code=403)
        item = approvals_store().ask(conv, turn, str((body or {}).get("question") or ""),
                             str((body or {}).get("action") or ""), str((body or {}).get("class") or ""), str((body or {}).get("tier") or "high"))
    _nudge_later(str(item.get("id") or ""), str((body or {}).get("action") or ""))
    # How long the machine waits for him is decided here, where the honest answer lives: has a page
    # looked at the app recently? With him present a High question holds the full ten minutes and he
    # can answer whenever he picks the phone up. With nobody there the turn is not held hostage: a
    # short look, then the step is skipped and the turn carries on.
    _present = (time.time() - float(_LAST_POLL.get("all") or 0)) < 30
    _tier = str((body or {}).get("tier") or "high")
    # A High question is held open for the full window whether or not a page is attached: he can
    # answer it from WhatsApp, and the turn carries on in the app afterwards. Softer questions do
    # not hold a turn hostage when nobody is looking.
    _window = _approvals.ASK_TTL_SECONDS if _tier == "high" else (90 if _present else 25)
    deadline = time.time() + _window
    try:
        while time.time() < deadline:
            with approval_lock():
                if APPROVAL_SECRETS.get((conv, turn)) != secret:
                    approvals_store().expire("turn ended", question=item["id"])
                    return JSONResponse({"ok": True, "allow": False, "id": item["id"],
                                         "reason": "the question ended with its turn"})
            # Read the row by id, whatever its state: an answered question leaves the
            # pending set, so polling that set can never observe the answer.
            now_row = approvals_store()._read(approvals_store().pending_path).get(item["id"]) or {}
            state = now_row.get("state")
            if state == "expired":
                return JSONResponse({"ok": True, "allow": False, "id": item["id"],
                                     "reason": "the question ended with its turn"})
            if state == "answered":
                data = approvals_store()._read(approvals_store().pending_path).get(item["id"]) or {}
                outcome = data.get("outcome") or "deny"
                approvals_store().audit(conv, turn, item["action"], item["class"],
                                approvals_store().mode(conv), outcome, "answered by owner")
                return JSONResponse({"ok": True, "allow": outcome == "allow", "id": item["id"]})
            await asyncio.sleep(0.5)
        reason = ("nobody was looking at the app, so the step was skipped" if not _present
                  else "the question ended with its turn")
        return JSONResponse({"ok": True, "allow": False, "id": item["id"], "reason": reason})
    finally:
        approvals_store().expire("request ended", question=item["id"])


# --- per-chat turn settings (web search, memory context) -------------------------------------
CHAT_SETTINGS_PATH = os.path.join(HERE, "chat_settings.json")

WEB_CAPABLE = ("web_search", "web_extract", "browser_exec", "browser_vault_list")


WEB_STEP_WORDS = ("search", "brows", "web", "page", "looked up", "checked the site")


def web_used(conv, tid, since=None):
    """True when a search or browse tool actually ran in this turn.

    The record keeps human step labels rather than tool names, and its rows carry their own hex id
    rather than the machine's turn number, so the test is on the label of the most recent row —
    the one written as this turn closed."""
    try:
        newest = None
        with open(os.path.join(HERE, "executions.jsonl"), encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                if since is not None and float(row.get("started") or 0) < float(since) - 120:
                    continue
                if newest is None or float(row.get("started") or 0) >= float(newest.get("started") or 0):
                    newest = row
        if not newest:
            return False
        steps = newest.get("steps") or []
        if isinstance(steps, str):
            steps = [steps]
        for st in steps:
            name = st.get("tool") if isinstance(st, dict) else str(st)
            low = str(name).lower()
            if str(name) in WEB_CAPABLE or any(w in low for w in WEB_STEP_WORDS):
                return True
    except Exception:
        return False
    return False


WEB_ALWAYS_STRONG = (
    "He set this chat to Always search. You have not searched yet, and the answer is not allowed to "
    "stand without it: call web_search now, then answer from what it returns and cite each source "
    "you used with its link. If the search returns nothing usable, say so plainly.")



def chat_settings(conv):
    """Per-chat web search (auto|always|off) and memory (on|off). Absent means the defaults."""
    try:
        with open(CHAT_SETTINGS_PATH, encoding="utf-8") as f:
            data = json.load(f) or {}
    except Exception:
        data = {}
    e = data.get(str(conv or "")) or {}
    web = str(e.get("web") or "auto").lower()
    if web not in ("auto", "always"):
        web = "auto"          # a stored "off" is gone: the web is always available now
    mem = str(e.get("memory") or "on").lower()
    return {"web": web, "memory": "off" if mem == "off" else "on"}


def set_chat_settings(conv, web=None, memory=None):
    with approval_lock():
        try:
            with open(CHAT_SETTINGS_PATH, encoding="utf-8") as f:
                data = json.load(f) or {}
        except Exception:
            data = {}
        e = data.get(str(conv or "")) or {}
        if web is not None:
            e["web"] = web if web in ("auto", "always") else "auto"
        if memory is not None:
            # A client says false, not "off". Only the string was understood, so a switch turned off
            # was stored as on and the memory kept loading into the turn.
            if isinstance(memory, bool):
                off = not memory
            else:
                off = str(memory).strip().lower() in ("off", "false", "0", "no", "disabled", "")
            e["memory"] = "off" if off else "on"
        data[str(conv or "")] = e
        tmp = CHAT_SETTINGS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=1)
        os.replace(tmp, CHAT_SETTINGS_PATH)
        return {"web": e.get("web", "auto"), "memory": e.get("memory", "on")}


@app.get("/api/chat/{conv}/turnopts")
async def get_turnopts(conv: str, request: Request):
    if not auth_scope(request):
        return JSONResponse({"ok": False, "error": "sign in"}, status_code=401)
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    return JSONResponse({"ok": True, "chat": conv, **chat_settings(conv)})


@app.post("/api/chat/{conv}/turnopts")
async def post_turnopts(conv: str, request: Request):
    if not auth_scope(request):
        return JSONResponse({"ok": False, "error": "sign in"}, status_code=401)
    try:
        body = await request.json()
    except Exception:
        body = {}
    body = body or {}
    out = set_chat_settings(conv, web=body.get("web"), memory=body.get("memory"))
    return JSONResponse({"ok": True, "chat": conv, **out})


@app.get("/api/chat/{conv}/permissions")
async def chat_permissions(conv: str, request: Request):
    who = auth_scope(request)
    if not who:
        return JSONResponse({"ok": False, "error": "sign in"}, status_code=401)
    return JSONResponse({"ok": True, "chat": conv, "mode": approvals_store().mode(conv),
                         "auto_enabled": AUTO_ENABLED,
                         "pending": len(approvals_store().pending_for(conv))})


@app.post("/api/chat/{conv}/permissions")
async def set_chat_permissions(conv: str, request: Request):
    who = auth_scope(request)
    if not who:
        return JSONResponse({"ok": False, "error": "sign in"}, status_code=401)
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        body = await request.json()
    except Exception:
        body = {}
    wanted = str((body or {}).get("mode") or "ask").lower()
    if wanted == "auto" and not AUTO_ENABLED:
        # Auto-approve opens only once the audit log and redaction are in place.
        return JSONResponse({"ok": False, "error": "auto-approve is not enabled yet"}, status_code=409)
    mode = approvals_store().set_mode(conv, wanted)
    approvals_store().audit(conv, "", "permissions mode", "setting", mode, "changed", "by %s" % who)
    return JSONResponse({"ok": True, "chat": conv, "mode": mode})


@app.get("/api/chat/{conv}/pending")
async def chat_pending(conv: str, request: Request):
    who = auth_scope(request)
    if not who:
        return JSONResponse({"ok": False, "error": "sign in"}, status_code=401)
    _LAST_POLL["all"] = time.time()
    return JSONResponse({"ok": True, "chat": conv, "ttl": _approvals.ASK_TTL_SECONDS,
                         "pending": _redact.redact_rows(approvals_store().pending_for(conv))})


@app.get("/api/pending")
async def all_pending(request: Request):
    """Every question waiting for him, whatever conversation asked it.

    The card is drawn from the chat the page believes it is in, and a page that has only just
    opened has no conversation name yet — so a question asked in that first turn had nowhere to
    appear and the turn sat waiting for an answer nobody could give. This route does not care
    which chat is on screen.
    """
    who = auth_scope(request)
    if not who:
        return JSONResponse({"ok": False, "error": "sign in"}, status_code=401)
    rows = approvals_store()._read(approvals_store().pending_path) or {}
    # A waiting question is stored as "pending"; answered, expired and denied are finished.
    items = [r for r in rows.values() if str(r.get("state") or "") not in ("answered", "expired", "denied", "cancelled")]
    items.sort(key=lambda r: r.get("asked") or 0)
    _LAST_POLL["all"] = time.time()
    return JSONResponse({"ok": True, "ttl": _approvals.ASK_TTL_SECONDS,
                         "pending": _redact.redact_rows(items)})


# A question raised while his phone is in his pocket has nobody to show itself to, and it used to wait
# out its two minutes and be refused. The app cannot be relied on to be open, so the question goes to
# where he already is: his own WhatsApp line, once, and only when nothing has looked at the app lately.
_LAST_POLL = {"all": 0.0}


def _nudge_later(qid: str, plain: str) -> None:
    def worker():
        try:
            time.sleep(20)
            row = approvals_store()._read(approvals_store().pending_path).get(qid) or {}
            if str(row.get("state")) != "pending":
                return                      # answered, expired, or gone: nothing to say
            if time.time() - float(_LAST_POLL.get("all") or 0) < 20:
                return                      # the app is open and already showing it
            text = ("One decision is waiting: %s\n\nReply *approve* or *deny* here and the turn "
                    "carries on in the app. Open JARVIS if you would rather press the button. "
                    "No answer in ten minutes and the step is skipped."
                    % (plain or "an action needs your approval"))
            _bin = os.environ.get("JARVIS_HERMES_BIN") or "/home/ubuntu/.local/bin/hermes"
            subprocess.run([_bin, "send",
                            "-t", "whatsapp:108590346063990@lid", text],
                           timeout=60, check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass
    try:
        threading.Thread(target=worker, daemon=True).start()
    except Exception:
        pass


@app.post("/api/turn/answer")
async def turn_answer(request: Request):
    who = auth_scope(request)
    if not who:
        return JSONResponse({"ok": False, "error": "sign in"}, status_code=401)
    if not _guard_owner(request):
        return JSONResponse({"ok": False, "error": "refused"}, status_code=403)
    try:
        body = await request.json()
    except Exception:
        body = {}
    body = body or {}
    res = approvals_store().answer(body.get("id"), body.get("conv"), body.get("turn"), bool(body.get("allow")))
    if not res.get("ok"):
        return JSONResponse(res, status_code=409)
    return JSONResponse(res)


@app.get("/api/audit")
async def audit_tail(request: Request, limit: int = 50):
    who = auth_scope(request)
    if not who:
        return JSONResponse({"ok": False, "error": "sign in"}, status_code=401)
    return JSONResponse({"ok": True, "rows": _redact.redact_rows(approvals_store().audit_rows(max(1, min(limit, 500))))})




@app.get("/api/openui/health")
def openui_health(request: Request):
    if auth_scope(request) not in ("master", "full") or not same_origin(request):
        return JSONResponse({"ok": False}, status_code=403)
    try:
        return JSONResponse({"ok": True, "validator": OPENUI.validator_health(), "runtime": OPENUI.asset_stamp(), "evidence_version": 3})
    except Exception as exc:
        return JSONResponse({"ok": False, "error": _redact.redact(str(exc))[:240]}, status_code=503)


@app.get("/api/openui/runtime")
def openui_runtime(request: Request, v: str = ""):
    if auth_scope(request) not in ("master", "full"):
        return JSONResponse({"ok": False}, status_code=403)
    if v != OPENUI.asset_stamp():
        return JSONResponse({"ok": False}, status_code=404)
    address = urllib.parse.urlsplit(str(request.base_url))
    origin = (str(request.base_url).rstrip("/") if address.hostname in ("127.0.0.1", "localhost", "::1")
              else "https://" + address.netloc)
    html, headers = OPENUI.document(origin)
    return HTMLResponse(html, headers=headers)


@app.get("/api/openui/images")
def openui_images(request: Request, q: str = "", conv: str = ""):
    if auth_scope(request) not in ("master", "full") or not same_origin(request):
        return JSONResponse({"ok": False}, status_code=403)
    if not re.fullmatch(r"[0-9a-f]{32}", conv):
        return JSONResponse({"photos":[],"diagnostic":{"code":"invalid_image_query"}},status_code=400)
    if chat_settings(conv).get("web") == "off":
        return JSONResponse({"photos": [], "diagnostic":{"code":"web_disabled"}})
    try:
        lookups=[]
        photos=OPENUI_IMAGES.search(q,diagnostics=lookups)
        return JSONResponse({"photos":photos,"diagnostic":{"code":"ok" if photos else "no_licensed_candidates","candidates":len(photos),"lookups":lookups}})
    except ValueError:
        return JSONResponse({"photos":[],"diagnostic":{"code":"invalid_image_query"}},status_code=400)
    except Exception as error:
        code=getattr(error,"code",None)
        return JSONResponse({"photos":[],"diagnostic":{"code":"image_broker_failed","upstream_status":code if isinstance(code,int) else None}},status_code=502)


@app.get("/api/response/context/{conv}")
def response_context(conv: str, request: Request):
    if auth_scope(request) not in ("master", "full") or not same_origin(request):
        return JSONResponse({"ok": False}, status_code=403)
    if not re.fullmatch(r"[0-9a-f]{32}", conv):
        return JSONResponse({"ok": False}, status_code=400)
    manifest, digest, stamp, *_ = RESPONSE_LAYER.assets()
    account = next(iter((accounts().get("accounts") or {}).values()), {})
    # A namespace, never a credential. A new sign-in cannot read an old session's checkpoints.
    epoch = hmac.new(TOKEN.encode(), (cookie_token(request) + "|response").encode(), hashlib.sha256).hexdigest()
    return JSONResponse({"ok": True, "account": account.get("id") or "acc_owner", "epoch": epoch,
                         "prefs": RESPONSE_LAYER.preferences(CHAT_SETTINGS_PATH, conv),
                         "canConfigure": bool(_guard(request)), "enabled": WIDGETS.enabled(),
                         "widgetOrigin": "https://" + WIDGETS.host(), "manifest": digest, "runtime": stamp},
                        headers={"Cache-Control": "no-store"})


@app.post("/api/response/preferences/{conv}")
async def response_preferences(conv: str, request: Request):
    if not _guard(request) or not same_origin(request):
        return JSONResponse({"ok": False}, status_code=403)
    if not re.fullmatch(r"[0-9a-f]{32}", conv):
        return JSONResponse({"ok": False}, status_code=400)
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > RESPONSE_LAYER.assets()[0]["budgets"]["settingsBytes"]:
            return JSONResponse({"ok": False}, status_code=413)
        raw.extend(chunk)
    try:
        value = RESPONSE_LAYER.save_preferences(CHAT_SETTINGS_PATH, conv, json.loads(raw), approval_lock())
    except (ValueError, OSError, TypeError):
        return JSONResponse({"ok": False}, status_code=400)
    return JSONResponse({"ok": True, "response": value}, headers={"Cache-Control": "no-store"})


@app.post("/api/page/turns/{conv}/{turn}/approval")
async def page_turn_approval(request: Request, conv: str, turn: str):
    return await PAGE_TEXT.approval(request, conv, turn)


@app.post("/api/page/prewarm")
async def page_prewarm(request: Request):
    return await PAGE_TEXT.prewarm(request)


if __name__ == "__main__":
    missing = [n for n, v in [("DEEPSEEK_API_KEY", DS_KEY), ("FISH", FISH_KEY)] if not v]
    if missing:
        print("missing:", missing); raise SystemExit(1)
    report_devices()
    threading.Thread(target=warm_whisper, daemon=True).start()
    # Open event streams (the page's own screen channel) would otherwise hold the process open on
    # SIGTERM and every restart would stall until systemd kills it. Cap the graceful window instead.
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning",
                timeout_graceful_shutdown=3)
