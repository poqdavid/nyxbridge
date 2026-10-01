import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import telegram  # noqa: E402

RUN = "https://github.com/poqdavid/nyxbridge/actions/runs/1"
SHA = "0123456789abcdef"


class Caption(unittest.TestCase):
    def test_layout(self):
        text = telegram.caption("CI", "v1.0.0", "fix: a thing\n\nWhy it was wrong.\nSecond line.\n\nMore.", "poqdavid", "branch", "main", SHA, RUN)
        self.assertEqual(
            text.split("\n"),
            [
                "Channel: <b>CI</b>",
                "Version: <b>v1.0.0</b>",
                "",
                "Commit:",
                "<pre>fix: a thing",
                "",
                "Why it was wrong. Second line.</pre>",
                "Author: <b>poqdavid</b>",
                "Branch: <b>main@0123456</b>",
                f'GitHub Action: <a href="{RUN}">Open run</a>',
            ],
        )

    def test_release_uses_tag_and_links_the_release(self):
        text = telegram.caption("Release", "v1.0.0", "First release", "poqdavid", "tag", "v1.0.0", SHA, RUN, "https://x/r")
        self.assertIn("Tag: <b>v1.0.0@0123456</b>", text)
        self.assertIn('Release: <a href="https://x/r">Release notes</a>', text)
        self.assertNotIn("<pre>First release\n\n", text)

    def test_html_is_escaped(self):
        text = telegram.caption("CI", "v1", "a <b> & \"c\"", "x<y>", "branch", "main", SHA, "")
        self.assertIn("<pre>a &lt;b&gt; &amp; &quot;c&quot;</pre>", text)
        self.assertIn("Author: <b>x&lt;y&gt;</b>", text)
        self.assertNotIn("GitHub Action", text)

    def test_long_messages_fit_the_limit(self):
        for body in ["word " * 400, "&" * 900, "x" * 5000]:
            for subject in ["short", "s" * 2000, "<" * 600]:
                text = telegram.caption("CI", "v1.0.0", f"{subject}\n\n{body}", "a", "branch", "main", SHA, RUN, "https://x/r")
                self.assertLessEqual(len(text), telegram.CAPTION_LIMIT)
                self.assertTrue(text.startswith("Channel: <b>CI</b>"))
                self.assertIn("Open run", text)

    def test_summary_is_shortened_before_the_subject(self):
        text = telegram.caption("CI", "v1", "keep this subject\n\n" + "y" * 3000, "a", "branch", "main", SHA, RUN)
        self.assertIn("<pre>keep this subject\n\n", text)
        self.assertIn("…</pre>", text)

    def test_first_paragraph(self):
        self.assertEqual(telegram.first_paragraph("\n\n a\n b \n\nc"), "a b")
        self.assertEqual(telegram.first_paragraph(""), "")


if __name__ == "__main__":
    unittest.main()
