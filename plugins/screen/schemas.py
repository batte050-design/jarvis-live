"""Tool schemas for the screen plugin.

The description is what makes the agent reach for the tool at all. Prose in the persona cannot
out-compete an attractive built-in tool, and the model will happily describe a table in speech
instead of showing it unless the schema is explicit about which one is wanted.
"""

SCREEN_SHOW = {
    "name": "screen_show",
    "description": (
        "Put a thing on the user's actual screen, in front of them, where it stays. Use this "
        "whenever the answer is something to look at rather than only hear: a table of numbers, "
        "a list, the contents of a file, a set of measurements, a picture. Speech is for "
        "sentences, this is for anything with rows or columns in it. Pick the kind that matches "
        "the data instead of describing the data in prose, keep the label short, and still say "
        "one short sentence out loud so they know why it is there. This is the only way to show "
        "them anything: browser tools open pages invisibly and show nobody. If no screen is open "
        "the call says so, and then simply speak the answer."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "kind": {
                "type": "string",
                "enum": ["text", "table", "list", "code", "metrics", "chart", "image", "link",
                         "widget", "video"],
                "description": ("text = a short block of prose held large; table = columns and "
                                "rows; list = one item per line; code = preformatted text kept "
                                "verbatim; metrics = a few numbers with short names, use for "
                                "measurements; image = a picture from an https URL; link = one "
                                "https URL to open; widget = an interactive panel, given as a "
                                "widget URL, framed in the page so a tap inside it can ask a "
                                "question. Use widget when the thing must respond to a touch: several "
                                "cards, a comparison, or a group of choices whose tap asks JARVIS the "
                                "question (the live app's tools/reply_widget.py builds one from a "
                                "reply JSON, and its gate must pass first); "
                                "video = one YouTube video to play, given in src as a watch "
                                "link, a youtu.be link, or the 11-character video id; "
                                "chart = a bar or line graph, given in data as one [label, value] "
                                "pair per point, with chart set to bar or line. Use chart whenever "
                                "he asks for a graph, a plot or a trend, instead of describing the "
                                "numbers in prose. A chart with no source is drawn with a warning "
                                "on it, so name where the figures came from."),
            },
            "label": {
                "type": "string",
                "description": "A short name for the thing, e.g. 'Disk usage'. Shown small above it.",
            },
            "text": {"type": "string", "description": "For kind=text or kind=code: the body."},
            "columns": {
                "type": "array",
                "items": {"type": "string"},
                "description": "For kind=table: the header cells, in order.",
            },
            "rows": {
                "type": "array",
                "items": {"type": "array", "items": {"type": "string"}},
                "description": "For kind=table: one array per row, each cell a string, the same "
                               "width as columns.",
            },
            "items": {
                "type": "array",
                "items": {"type": "string"},
                "description": "For kind=list: the lines. For kind=metrics: write each entry as "
                               "'name = value'.",
            },
            "src": {"type": "string", "description": "For kind=image: a full https image URL."},
            "chart": {"type": "string", "enum": ["bar", "line"],
                      "description": "For kind=chart: bar (default) or line. A bar chart starts "
                                     "at zero because a bar on a cut axis misstates the size."},
            "data": {
                "type": "array",
                "items": {"type": "array", "items": {"type": "string"}},
                "description": "For kind=chart: one [label, value] pair per point, in the order "
                               "they should read, e.g. [[\"FY2023/24\", \"18.38\"], "
                               "[\"FY2024/25\", \"21.25\"]]. Numbers go in as strings.",
            },
            "unit": {"type": "string", "description": "For kind=chart: the unit, e.g. 'T' or '%'."},
            "source": {"type": "string",
                       "description": "For kind=chart: where the figures came from, and when."},
            "href": {"type": "string", "description": "For kind=link: a full https URL."},
            "url": {"type": "string",
                    "description": "For kind=widget: the widget's own https URL, as created for "
                                   "it. Only the widget origin is ever framed; any other URL is "
                                   "refused."},
        },
        "required": ["kind"],
    },
}

SCREEN_CLEAR = {
    "name": "screen_clear",
    "description": "Take the thing off the user's screen. Use when they say to clear it, close "
                   "it, or take that down.",
    "parameters": {"type": "object", "properties": {}},
}
