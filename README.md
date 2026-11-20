# motmot

mot mot is a Chrome extension for Twitter. It does three things:

- **Highlight to Tweet**: send any text you highlight on the web straight to
  Twitter, quoted with its source, without losing your place.
- **Jump back in time**: long-press a Tweet on Twitter to open the author's profile
  rewound to the moment they posted it.
- **Random old Tweet**: right-click a Tweet on Twitter to see a random Tweet from
  the author's last five years, right there in your feed.

None of it uses Twitter's API or needs an API key. mot mot works through Twitter's own
web app, signed in as you, and sends nothing anywhere else.

![motmotdemo1](https://user-images.githubusercontent.com/58536863/236895019-c900f814-c6d1-40ed-b73e-848b693b8a41.JPG)
![motmotdemo2](https://user-images.githubusercontent.com/58536863/236895024-bb127d09-3d96-4515-8a6f-d9f84ef15cfe.JPG)

## Install

1. **[Download mot mot](https://github.com/polymathematics/motmot/releases/latest/download/motmot.zip)**
   (always the latest release) and unzip it.
2. Go to `chrome://extensions` and turn on **Developer mode** (top right).
3. Drag the unzipped `motmot` folder onto the extensions page.

To update, replace your `motmot` folder with the new one and click reload on
mot mot in `chrome://extensions`. Past versions and what changed in each are on
the [Releases](https://github.com/polymathematics/motmot/releases) page.

## Highlight to Tweet

Three ways to send a Tweet:

- **Right-click** a selection and pick **Tweet "…"**.
- **⌘⇧Y** (`Ctrl+Shift+Y` on Windows and Linux) Tweets the selection without
  touching the mouse. Rebind it from the popup's *set a shortcut* link.
- **Click the icon** to open the composer. It picks up whatever is
  highlighted, lets you edit before sending, and previews the finished Tweet
  with a live character count. ⌘⏎ sends. The footer counts how many Tweets
  you've sent with mot mot.

The right-click menu also offers **Tweet this page**, for when the page itself
is the point, and **Copy selection with source**, for when the quote is going
somewhere other than Twitter.

### The Tweet

Every Tweet takes the same shape:

> “your highlight” from https://example.com/page. tweeted via mot mot!

mot mot counts characters the way Twitter does: links always cost 23, and CJK and
emoji cost two. It trims an over-long highlight at a word boundary rather than
letting Twitter reject the Tweet. On a page with no usable link, such as a local file
or a `chrome://` tab, the `from …` clause drops out.

## Jump back in time

On Twitter, **long-press any Tweet**: hold the mouse button, or your finger, for
about half a second.

- **Opening the profile:** mot mot opens the author's profile and starts
  scrolling back right away, with a colored progress bar filling as it goes.
- **Arriving:** the Tweet you came from is centered on screen and lit by a
  shimmering glow that brightens, then fades. Scrolling down carries on back
  in time.
- **Back to now:** the banner at the top offers **Back to now**, which returns
  the profile to the present. The banner fades away when you leave the
  profile.
- **New tab:** hold ⌘ (`Ctrl` on Windows and Linux) while you press to open it
  in a new tab.
- **Holding a random old Tweet:** this works on the random old Tweets below,
  too.

A right-click, or a ⌃-click on a Mac, never sets off a long press, so the
context menu still works normally.

**How it works.** A Tweet's ID encodes the moment it was posted, and the
cursor Twitter's web app uses to page through a profile is just an encoded Tweet ID.
So mot mot hands the profile's first page load a cursor pointing at your
Tweet. If Twitter doesn't accept that, mot mot scrolls the profile back itself. If a
profile won't load back that far, it falls back to Twitter search.

## A random old Tweet

On Twitter, **right-click any Tweet** and choose **Random old Tweet from @author**.

- **Loading:** the Tweet blurs under a shimmering border while mot mot looks.
- **Arriving:** a Tweet from a random moment in the author's last five years
  (or since they joined) takes its place, with the same arrival glow. You
  never leave the page.
- **Another** picks again. It's usually instant.
- **✕** puts the original Tweet back.
- **Open on X** opens the old Tweet. Holding it rewinds the author's profile
  to that moment.

mot mot skips filler: a Tweet that's only an @mention, only emoji, or only a
GIF is never picked. Photo and video Tweets still are, even with no caption.
Highlighting text in a Tweet still gives you the usual **Tweet "…"** option
alongside this one.

**How it works.** Twitter's search can jump straight to any stretch of time
(`from:author since:… until:…`), so one search lands on a random month of
someone's history. Only Twitter's own app can run that search, and Twitter won't load in a
hidden frame. So the first pick opens Twitter in a small **minimized window** and
reads the results from there.

- **Reuse:** the window is kept for ten minutes, and later picks just move it
  to a new search.
- **Prefetch:** pressing the right button on a Tweet starts fetching that
  author's Tweets before you've even chosen the menu item.
- **Closing it:** the window closes itself when it's not used. You can also
  close it any time; the next pick reopens it.
- **Quiet months:** if the random month is empty, mot mot widens the search
  to a year, then to all five.

## Notes

mot mot is built for Manifest V3. Version 2.0 was a full rewrite: Chrome
stopped running Manifest V2 extensions, so the 1.0 version no longer loads at
all.

Permissions:

- `contextMenus` for the right-click items.
- `activeTab` and `scripting` to read the selection for the keyboard shortcut,
  and to copy a selection with its source.
- `storage` for the Tweets-sent counter and the random-pick window's state.
- `notifications` to tell you when a page won't let mot mot copy from it.
  A successful copy just flashes a ✓ on the icon.
- `alarms` to close the random-pick window when it's idle.

The sign-off is part of the template and is not configurable. That is the
point of it.
