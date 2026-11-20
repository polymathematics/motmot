# motmot

MotMot is a highlight-to-Tweet Chrome extension. Highlight text anywhere on the
web and send it to X without losing your place.

![motmotdemo1](https://user-images.githubusercontent.com/58536863/236895019-c900f814-c6d1-40ed-b73e-848b693b8a41.JPG)
![motmotdemo2](https://user-images.githubusercontent.com/58536863/236895024-bb127d09-3d96-4515-8a6f-d9f84ef15cfe.JPG)

## Install

1. **[Download mot mot](https://github.com/polymathematics/motmot/releases/latest/download/motmot.zip)**
   (the latest release) and unzip it.
2. Go to `chrome://extensions` and toggle **Developer mode** on (top right).
3. Drag the unzipped `motmot` folder onto the extensions page.

Past versions are on the [Releases](https://github.com/polymathematics/motmot/releases) page.

## Use it

Three ways to send a Tweet:

- **Right-click** a selection and pick **Tweet "…"**.
- **⌘⇧Y** (`Ctrl+Shift+Y` on Windows and Linux) Tweets the selection without
  touching the mouse. Rebind it from the popup's *set a shortcut* link.
- **Click the icon** to open the composer, which picks up whatever is
  highlighted and lets you edit before sending. ⌘⏎ sends.

The right-click menu also offers **Tweet this page**, for when the page itself
is the point, and **Copy selection with source**, for when the quote is going
somewhere other than X.

## Jump back in time

On X, **long-press any Tweet** (hold the mouse button or your finger for about
half a second) to open the author's profile, rewound to the moment they posted
it. The screen glows faintly while it rewinds. The Tweet you came from is marked in blue, and scrolling down carries on
back in time. Hold ⌘ (`Ctrl` on Windows and Linux) while you press to open it
in a new tab; **Back to now** in the banner returns the profile to the present.

This doesn't use X's API. A Tweet's ID encodes the moment it was posted, and
the cursor X's own web app uses to page through a profile is just an encoded
Tweet ID. So mot mot hands the profile's first page load a cursor pointing at
your Tweet. If X ever stops accepting that, mot mot scrolls the profile back
itself, with a progress bar, and falls back to X search when a profile won't
load back that far.

## A random old Tweet

On X, **right-click any Tweet** and choose **Random old Tweet from @author**.
The Tweet blurs under a shimmering border, and a Tweet from a random moment in
the last two years of their history takes its place. You never leave the page.
**Another** picks again, **✕** puts the original back, **Open on X** opens the
old one, and holding it rewinds their profile to that moment. Highlighting text
still gives you the usual **Tweet "…"** option alongside it.

To find it, mot mot uses X's own search, which can jump straight to any
stretch of time (`from:author since:… until:…`). X only lets its own app run
that search, and won't load in a hidden frame, so the first pick opens X in a
small minimized window and reads the results from there. That window is kept
for ten minutes: later picks take a moment, a right-press on a Tweet gets
that author's Tweets fetched before you've chosen the menu item, and
**Another** is usually instant. Close the window any time; the next pick
opens it again.

## The Tweet

Every Tweet takes the same shape:

> “your highlight” from https://example.com/page. tweeted via mot mot!

MotMot counts characters the way X does — links always cost 23, and CJK and
emoji cost two — and trims an over-long highlight at a word boundary rather
than letting X reject the Tweet. The popup previews the finished Tweet and
counts down what the highlight has left. On a page with no usable link — a
local file, a `chrome://` tab — the `from …` clause drops out.

## Notes

Version 2.0 is a Manifest V3 rewrite. Chrome stopped running Manifest V2
extensions, so the 1.0 version no longer loads at all.

The sign-off is part of the template and is not configurable — that is the
point of it.
