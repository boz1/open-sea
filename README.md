# Open Sea — Boat Trip Planner

A small map + itinerary app for boat trips: mark stops on a map, group them
into days, and edit live with your crew. Static site (Leaflet + vanilla JS),
no build step, deployable on GitHub Pages. Live multi-person sync is powered
by Firebase Firestore (free tier), called directly from the browser.

The app supports multiple **sessions** — one per trip. Anyone can create a
new session with a name and a password; joining an existing session needs
that same name + password. This keeps unrelated trip groups from wandering
into each other's data on the same deployed app. See "A note on the
password gate" below for what this does and doesn't protect against.

## 1. Try it locally first

Just open `index.html` in a browser — it works immediately using your
browser's local storage (sessions stay on your device only, until you set
up Firebase in the next step).

If double-clicking the file causes issues, serve it locally instead:

```
npx serve .
```

then open the printed `http://localhost:...` URL.

## 2. Turn on live sync with friends (Firebase Firestore)

Takes about 5 minutes, free.

1. Go to <https://console.firebase.google.com>, sign in, click **Add project**,
   give it any name (e.g. `open-sea`), skip Google Analytics.
2. In the left menu: **Build → Firestore Database → Create database**.
   Choose any nearby region. Start in **production mode** (we set our own
   rules below).
3. Go to **Firestore Database → Rules** and replace the contents with:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /sessions/{sessionId} {
         allow read, write: if true;
       }
     }
   }
   ```

   This keeps things simple: anyone who has the app link, a session name,
   and its password can read/write that session's data — no accounts
   needed. Click **Publish**.
4. Click the gear icon (top left) → **Project settings**, scroll to
   **Your apps**, click the **`</>`** (web) icon, register an app (any
   nickname, no need for Firebase Hosting).
5. Firebase shows a `firebaseConfig` object. Copy its values into
   [js/firebase-config.js](js/firebase-config.js), replacing the placeholders.
6. Reload the app — the dot next to the title should turn green once you're
   inside a session (live sync). Open the page on two devices/tabs, join the
   same session on both, and confirm edits show up on both.

## 3. Put it online with GitHub Pages

```
git init
git add .
git commit -m "Open Sea trip planner"
```

Create an empty repo on GitHub, then:

```
git remote add origin https://github.com/<your-username>/open-sea.git
git branch -M main
git push -u origin main
```

Then on GitHub: **Settings → Pages → Build and deployment → Source: Deploy
from a branch**, branch `main`, folder `/ (root)` → **Save**. GitHub gives
you a URL like `https://<your-username>.github.io/open-sea/` within a
minute or two — that's the link to share with friends.

Any time you push new commits to `main`, the live site updates automatically.

## Using the app

- **Landing screen**: create a new session (just pick a trip name — a
  4-digit password is generated for you) or join an existing one (name +
  password someone else set up). After creating a session you'll see its
  password once, plus a "Copy share link" button. Sessions you've unlocked
  on this device are remembered for next time — click the ⇄ button in the
  top bar to switch sessions.
- **🔗 Share**: the top-bar button copies a link that pre-fills the session
  name for whoever opens it — they only need to type the password. The same
  link appears right after creating a session, ready to paste into a chat.
- **Add Stop on Map**: click the button in the sidebar, then click anywhere
  on the map to drop a pin; a form pops up to name it, assign it to a day,
  and add a time/notes/type (anchorage, swim spot, sight, town, food). You
  can also nudge a stop's exact coordinates from that same form.
- Hovering a sidebar stop highlights its pin on the map, and hovering a pin
  highlights its sidebar row and shows a preview popup (name/time/notes)
  with an **Edit** button — clicking the pin itself just opens that preview,
  editing needs the explicit button (works with tap on mobile too).
- **+ Add Day** creates a new day card with a native date picker. The whole
  trip is drawn as one continuous, hoverable route: same-day stops connect
  with a dashed line in that day's color, the hop into the next day
  connects with a plain gray line, and hovering any segment shows its
  distance and estimated time.
- Use the ▲/▼ buttons on a stop to reorder it within its day.
- **⛵ Boat & speed**: pick a boat type (catamaran, monohull, gulet,
  motorboat) or set a custom average speed in knots. Every day card shows
  an estimated underway time + distance based on straight-line distance
  between stops, plus a running total for the whole trip.
- **Trip notes**: a list of separate free-text notes (add/remove each
  independently) in the sidebar for anything that applies to the whole trip
  (logistics, mooring rules, packing list, etc.), shared live like
  everything else.
- Click the ☰ button in the top bar to collapse the sidebar for more map
  room (slides in/out as an overlay on mobile, shrinks to nothing on
  desktop).
- Everything in a session (title, notes, boat settings, days, stops, order)
  is stored in one shared document, so all changes sync to everyone in that
  session within a few seconds.

## A note on the password gate

Session passwords are hashed (SHA-256) in the browser before being compared
or stored — so a session's document doesn't contain the plain password.
That said, this is **not real security**: the Firestore rules above allow
anyone to read/write any session document directly (not just through the
app's UI), so a determined person who knows your Firebase project ID could
still enumerate session documents. Treat sessions as a way to keep casual
visitors and different trip groups from colliding with each other, not as
protection for sensitive information. Real per-user security would need
Firebase Authentication and a backend — more than a trip planner needs.

## Resetting or removing a session

Open the Firestore console → **Firestore Database → Data** → `sessions`
collection → delete the document for that session's slug (the session name,
lowercased and hyphenated, e.g. "Fethiye 2026" → `fethiye-2026`).
