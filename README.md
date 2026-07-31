# Fethiye Boat Trip Planner

A tiny map + itinerary app for the boat trip: mark stops on a map, group them
into days, and edit live with friends. Static site (Leaflet + vanilla JS),
no build step, deployable on GitHub Pages. Live multi-person sync is powered
by Firebase Firestore (free tier), called directly from the browser.

## 1. Try it locally first

Just open `index.html` in a browser — it works immediately using your
browser's local storage (edits stay on your device only, until you set up
Firebase in the next step).

If double-clicking the file causes issues, serve it locally instead:

```
npx serve .
```

then open the printed `http://localhost:...` URL.

## 2. Turn on live sync with friends (Firebase Firestore)

Takes about 5 minutes, free.

1. Go to <https://console.firebase.google.com>, sign in, click **Add project**,
   give it any name (e.g. `fethiye-trip`), skip Google Analytics.
2. In the left menu: **Build → Firestore Database → Create database**.
   Choose any nearby region. Start in **production mode** (we set our own
   rules below).
3. Go to **Firestore Database → Rules** and replace the contents with:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /trips/{tripId} {
         allow read, write: if true;
       }
     }
   }
   ```

   This keeps things simple: anyone with the app link can read/write the
   trip data, nobody needs an account. Fine for a private link shared only
   with your friends. Click **Publish**.
4. Click the gear icon (top left) → **Project settings**, scroll to
   **Your apps**, click the **`</>`** (web) icon, register an app (any
   nickname, no need for Firebase Hosting).
5. Firebase shows a `firebaseConfig` object. Copy its values into
   [js/firebase-config.js](js/firebase-config.js), replacing the placeholders.
6. Reload the app — the dot next to the title should turn green (live sync).
   Open the page on two devices/tabs and confirm edits show up on both.

## 3. Put it online with GitHub Pages

```
git init
git add .
git commit -m "Fethiye trip planner"
```

Create an empty repo on GitHub (e.g. `fethiye-trip`), then:

```
git remote add origin https://github.com/<your-username>/fethiye-trip.git
git branch -M main
git push -u origin main
```

Then on GitHub: **Settings → Pages → Build and deployment → Source: Deploy
from a branch**, branch `main`, folder `/ (root)` → **Save**. GitHub gives
you a URL like `https://<your-username>.github.io/fethiye-trip/` within a
minute or two — that's the link to share with friends.

Any time you push new commits to `main`, the live site updates automatically.

## Using the app

- **Add Stop on Map**: click the button in the sidebar, then click anywhere
  on the map to drop a pin; a form pops up to name it, assign it to a day,
  and add a time/notes/type (anchorage, swim spot, sight, town, food).
- Click any existing marker or itinerary row to edit or delete it.
- **+ Add Day** creates a new day card; each day's stops are connected on
  the map with a dashed line in that day's color.
- Use the ▲/▼ buttons on a stop to reorder it within its day.
- Everything (title, days, stops, order) is stored in one shared document,
  so all changes sync to everyone with the page open in a few seconds.

## Customizing the starting itinerary

`js/app.js` has a `DEFAULT_TRIP` object with placeholder Fethiye gulet-route
stops (Göcek islands, Gemiler Island, Butterfly Valley, Ölüdeniz, Kabak).
It's only used the very first time the shared Firestore document is created
— after that, edit everything directly in the app. To reset, delete the
`trips/fethiye` document in the Firestore console and reload.
