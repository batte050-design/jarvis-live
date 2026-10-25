"""Recorder tests against actual server worker output and malformed/legacy wire messages."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT),str(ROOT/'tools')]
import generative_evidence as E
import response_lookup as L
from routing40_driver import drive


def event(name,**data):return {'event':name,'data':data}


class EvidenceTests(unittest.TestCase):
    def test_authoritative_repair_and_terminal_verdict_override_provisional_partial(self):
        code='A complete answer.\n~~~openui-lang\nroot = Col([Text("Ready")])\n~~~'
        result=E.summarise([event('tok',d='broken'),event('note',partial=True),event('text',text=code),event('done',status='ok')])
        self.assertEqual(result['text'],code);self.assertEqual(result['server_status'],'ok');self.assertFalse(result['errors'])
        self.assertEqual(result['declared_openui'],1);self.assertIn('Text("Ready")',result['programs'][0]['code'])

    def test_prose_does_not_require_any_ui_event_or_fence(self):
        row=E.summarise([event('tok',d='Hello.'),event('done',status='ok')])
        self.assertEqual((row['answer_kind'],row['server_status'],row['declared_openui']),('prose','ok',0));self.assertFalse(row['errors'])

    def test_legacy_explicit_partial_is_not_relabelled_as_a_pass(self):
        row=E.summarise([event('note',partial=True),event('text',text='Readable fallback.'),event('done')])
        self.assertEqual(row['server_status'],'partial');self.assertTrue(row['errors'])

    def test_missing_verdict_is_unknown_not_a_failure_or_success_inferred_from_absence(self):
        row=E.summarise([event('text',text='Hello.'),event('done')]);self.assertEqual(row['server_status'],'unknown');self.assertFalse(row['errors'])

    def test_empty_final_text_replaces_provisional_payload(self):
        row=E.summarise([event('tok',d='broken program'),event('text',text=''),event('done',status='partial')]);self.assertEqual(row['text'],'')

    def test_unlabelled_lang_is_recorded_but_is_not_called_a_rendered_program(self):
        row=E.analyse_answer('Hello.\n```\n$q = 4\nroot = Col([Input($q, "Count")])\n```')
        self.assertEqual((row['answer_kind'],row['unlabelled_openui'],row['declared_openui']),('unlabelled_openui',1,0))

    def test_code_example_containing_a_nested_fence_is_not_opted_into_ui(self):
        row=E.analyse_answer('````markdown\n```openui\nroot = Col([])\n```\n````')
        self.assertEqual(row['declared_openui'],0);self.assertEqual(row['answer_kind'],'code')

    def test_sse_multiline_crlf_comments_and_unicode(self):
        wire=': ping\r\nevent: text\r\ndata: {"text":\r\ndata: "Hello — Kampala"}\r\n\r\nevent: done\r\ndata: {"status":"ok"}\r\n\r\n'
        rows=list(E.read_sse(wire.splitlines(keepends=True)));self.assertEqual(E.summarise(rows)['text'],'Hello — Kampala')

    def test_actual_worker_emits_ok_and_partial_terminal_status_with_diagnostics(self):
        for answer,status in [('Hello.','ok'),('Useful answer.\n```openui\nroot = Unknown("broken")\n```','partial')]:
            row={'q':'A fixture request','web':'auto','memory':'on','web_behavior':'none','model_action':'answer','front_answer':answer}
            with tempfile.TemporaryDirectory() as folder,contextlib.redirect_stdout(io.StringIO()):actual=drive(ROOT,folder,row)
            captured=E.summarise([event(name,**data) for name,data in actual['events']])
            self.assertEqual(captured['server_status'],status);self.assertEqual(captured['status_source'],'done.status')
            if status=='partial':self.assertTrue(any(d.get('presentation_errors') for n,d in actual['events'] if n=='note'))

    def test_shell_launcher_is_never_used_as_a_python_interpreter(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);engine=root/'hermes';marker=root/'SHELL_RAN'
            engine.write_text('#!/bin/sh\ntouch '+str(marker)+'\n');engine.chmod(0o700)
            with patch.dict('os.environ',{'JARVIS_LOOKUP_PYTHON':''}):
                with self.assertRaisesRegex(ValueError,'Set JARVIS_LOOKUP_PYTHON'):L.resolve_python(engine)
            self.assertFalse(marker.exists())

    def test_shell_launcher_can_use_an_explicit_engine_python(self):
        with tempfile.TemporaryDirectory() as folder:
            engine=Path(folder)/'hermes';engine.write_text('#!/bin/sh\nexit 1\n')
            with patch.dict('os.environ',{'JARVIS_LOOKUP_PYTHON':sys.executable}):self.assertEqual(L.resolve_python(engine),Path(sys.executable))
            with patch.dict('os.environ',{'JARVIS_LOOKUP_PYTHON':'/bin/sh'}):
                with self.assertRaisesRegex(ValueError,'Python 3 interpreter'):L.resolve_python(engine)


if __name__=='__main__':unittest.main()
