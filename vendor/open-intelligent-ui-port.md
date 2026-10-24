# Open Intelligent UI primitive port

Upstream: https://github.com/thesysdev/open-intelligent-ui/tree/0321343

Copyright (c) 2026 Thesys Inc. MIT license: LICENSE-open-intelligent-ui.txt.

`static/response-runtime.js`'s `composition()` and the appended primitive styles in
`static/response-runtime.css` adapt the layout, text, control and extra component semantics from
`src/lib/components/layout.tsx`, `text.tsx`, `controls.tsx`, `extra.tsx` and `components.css`.
The corresponding shared primitive contract in `response-capabilities.json` and compiler in
`response_composition.py` adapt the same library vocabulary and no-dead-input rule.

This is the brief's option (b): a bounded DOM port into the existing application renderer.
It is not an OpenUI Lang 1.0 parser or a claim of full OpenUI package compatibility.
Col, Row, Box, Grid, Card, Carousel, Popover, Form, List/Timeline, ListItem, Title, Text,
Caption, Label, Badge, Divider, Spacer, Input, Slider, Select, Checkbox, TextArea and DatePicker
are ported. Button uses the existing action broker; Output binds the existing typed outputs.

React, Next.js, Gateway, telemetry, external images/maps/YouTube, arbitrary HTML/CSS/JS,
OpenUrl/ToAssistant shortcuts and unreviewed form sends are deliberately not ported.
Unknown primitives and properties fail closed. Old stored widgets continue to use their
original renderer path when no optional layout is present.

The bounded port uses native details/summary for Popover rather than a floating React portal;
Carousel is a native swipe/keyboard scroller without the upstream arrow overlay. Timeline is
the upstream List timeline variant. Output is a JARVIS adapter to its existing typed outputs.
