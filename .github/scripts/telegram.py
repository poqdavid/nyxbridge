#!/usr/bin/env python3
"""Post a module zip to Telegram with a build caption.

    telegram.py --zip FILE --channel CI|Release --version VERSION [--release-url URL]

The caption: a channel/version header, the commit subject and its first body
paragraph, author, ref@sha, and links to the run (and the release, if any).
Telegram limits captions to 1024 characters, so the paragraph and then the
subject are shortened to fit.

Environment: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (skips quietly if unset),
RUN_URL, GIT_REF_NAME, GIT_REF_TYPE (branch|tag), GIT_SHA. The commit message
and author are read with git. A failed send is reported as a warning and
never fails the build.
"""
import argparse
import os
import subprocess
import sys

CAPTION_LIMIT = 1024


def escape(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def shorten(text, limit):
    if len(text) <= limit:
        return text
    if limit < 2:
        return ""
    return text[: limit - 1].rstrip() + "…"


def first_paragraph(body):
    para = []
    for line in body.splitlines():
        if line.strip():
            para.append(line.strip())
        elif para:
            break
    return " ".join(para)


def render(channel, version, subject, summary, author, ref_type, ref_name, sha, run_url, release_url):
    commit = subject + (f"\n\n{summary}" if summary else "")
    lines = [
        f"Channel: <b>{escape(channel)}</b>",
        f"Version: <b>{escape(version)}</b>",
        "",
        "Commit:",
        f"<pre>{escape(commit)}</pre>",
        f"Author: <b>{escape(author)}</b>",
        f"{'Tag' if ref_type == 'tag' else 'Branch'}: <b>{escape(ref_name)}@{escape(sha[:7])}</b>",
    ]
    if release_url:
        lines.append(f'Release: <a href="{escape(release_url)}">Release notes</a>')
    if run_url:
        lines.append(f'GitHub Action: <a href="{escape(run_url)}">Open run</a>')
    return "\n".join(lines)


def caption(channel, version, message, author, ref_type, ref_name, sha, run_url, release_url=""):
    """The caption, shortened to Telegram's limit (escaping counts toward it)."""
    subject, _, body = message.strip().partition("\n")
    subject = subject.strip()
    summary = first_paragraph(body)

    def build(subj, summ):
        return render(channel, version, subj, summ, author, ref_type, ref_name, sha, run_url, release_url)

    text = build(subject, summary)
    # Shorten the summary, then the subject, until the rendered caption fits.
    while len(text) > CAPTION_LIMIT and summary:
        summary = shorten(summary, len(summary) - (len(text) - CAPTION_LIMIT) - 1)
        text = build(subject, summary)
    while len(text) > CAPTION_LIMIT and subject:
        subject = shorten(subject, len(subject) - (len(text) - CAPTION_LIMIT) - 1)
        text = build(subject, summary)
    return text


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", required=True)
    ap.add_argument("--channel", required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument("--release-url", default="")
    a = ap.parse_args()

    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat = os.environ.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat:
        print("Telegram secrets not set; skipping notification.")
        return 0
    if not os.path.isfile(a.zip):
        print(f"::warning::{a.zip} not found; skipping Telegram.")
        return 0

    sha = os.environ.get("GIT_SHA") or git("rev-parse", "HEAD").strip()
    message = git("show", "-s", "--format=%B", sha)
    author = git("show", "-s", "--format=%an", sha).strip()
    text = caption(
        a.channel, a.version, message, author,
        os.environ.get("GIT_REF_TYPE", "branch"), os.environ.get("GIT_REF_NAME", "main"),
        sha, os.environ.get("RUN_URL", ""), a.release_url,
    )
    sent = subprocess.run(
        ["curl", "-sS", "-f", "-F", f"document=@{a.zip}",
         "--form-string", f"chat_id={chat}", "--form-string", "parse_mode=HTML",
         "--form-string", f"caption={text}",
         f"https://api.telegram.org/bot{token}/sendDocument"],
        capture_output=True, text=True,
    )
    if sent.returncode:
        print(f"::warning::Telegram send failed ({a.channel}): {sent.stderr.strip()}")
    else:
        print(f"Sent {os.path.basename(a.zip)} to Telegram ({a.channel}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
