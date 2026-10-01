# Waypoint

Walking turn-by-turn navigation for **Meta Ray-Ban Display** glasses. It shows a big turn arrow, the distance and the street name, with a heads-up mini map of your route underneath and spoken prompts.

Built from the [Meta Wearables Web Apps docs](https://wearables.developer.meta.com/docs/develop/webapps): 600×600 additive display (black is see-through), Neural Band arrow and Enter keys, phone-sourced `navigator.geolocation`, `DeviceOrientation` compass, and `speechSynthesis` for voice.

## Using it on the glasses

| Screen | Controls |
|---|---|
| Home | Select **Where to?** and say or write a place, address or postcode. Or pick a quick category (Coffee, Food, Pub, Station, Shop, Pharmacy, Cash, Toilets) to see the nearest ones. **Phone** shows your pairing code. Saved and Recent places sit underneath. |
| Results | Shows what the glasses heard and what was searched (e.g. *Heard "sw one a two a a" → SW1A 2AA*), and reads the top result aloud. Swipe up or down, then pinch to pick one, or use the box at the top to search again. |
| Route | Shows walk time, distance and arrival time. **Go** starts navigation. **☆ Save** adds the place to Saved. |
| Navigating | **Left/Right** previews earlier or later turns (it snaps back after 8 seconds). **Up/Down** zooms the map. **Pinch** opens the menu: Resume, Voice on/off, Map facing-up or north-up, Re-plan route, End route. Back also opens the menu, so you can't end a route by accident. |

If you go off the route by more than about 30 m, it plans a new one for you.

## Sound and voice

The glasses only have one built-in voice, and it isn't great. Waypoint gives you a choice. Change it any time from the route menu with **Sound: …**.

| Mode | What you hear | Needs |
|---|---|---|
| **Chimes** (default) | A soft ping about 60 m before a turn, then a two-note chime at the turn. Left turns play in your **left ear** (falling notes), right turns in your **right ear** (rising notes). Arrival is a little rising arpeggio. | Nothing |
| **Natural voice** | A natural Google voice (e.g. British "Charon" or "Kore") reads the directions, panned slightly toward the turn. The whole route's phrases are fetched when you press Go, so there's no delay at junctions. | A Google Text-to-Speech key |
| **Glasses voice** | The built-in voice | Nothing |
| **Off** | Silence | Nothing |

### Setting up the natural voice (about 5 minutes, one time)

1. Go to [console.cloud.google.com](https://console.cloud.google.com), sign in, and create a project (e.g. "Waypoint").
2. Search for **Cloud Text-to-Speech API** and click **Enable**. Google will ask you to set up billing. A card is required, but the free allowance is **1 million characters a month** for these voices, and a typical walk uses about 500.
3. Go to **APIs & Services → Credentials → Create credentials → API key**. Then click the key to edit it:
   - **Application restrictions:** Websites → add `https://<you>.github.io/*`
   - **API restrictions:** Restrict key → **Cloud Text-to-Speech API**
4. Optional but sensible: under **Billing → Budgets & alerts**, set a £1 budget alert.
5. On your phone, open the send page. Under **Voice for directions**, paste the key, pick a voice, and tap **▶ Preview**. With Waypoint open on the glasses, tap **Send to glasses**. The glasses will say hello in the new voice.

The key goes straight from your phone to your glasses (it isn't stored on the relay or in GitHub). To go back to chimes, use **Switch the glasses back to chimes** on the phone page.

## Finding places

- **Postcodes:** whatever the glasses hear ("sw one a two a a", "S.W.1A2AA", "sw1a zaa", "double you see two aitch…", even the NATO alphabet) is cleaned up, checked against [postcodes.io](https://postcodes.io), the free official UK postcode data, and shown with its street name.
- **Categories:** say "nearest chemist", "loo", "coffee" or "tube", or tap a chip, for the closest places. These come from OpenStreetMap via Overpass.
- **Names:** filler words like "take me to" are removed. Then Mapbox (if you have a key), Photon and Nominatim are searched together, duplicates are merged, and results are ranked by how good the match is and how close it is. If nothing matches, it tries again without words that were probably misheard.

## Send from phone

Typing on a phone is far easier than dictating to glasses.

1. On the glasses, press **Phone**. You'll see a web address and an 8-character code.
2. On your iPhone, open that address (`https://<you>.github.io/waypoint/send.html`) in Safari. Tap **Share → Add to Home Screen** so it's one tap away next time.
3. Enter the code once. The glasses say "Phone paired".
4. Type a place (results appear as you type) or paste an Apple Maps or Google Maps link, then tap **Send**. Waypoint opens the route on the glasses.

If the glasses app is closed when you send, the place is waiting for you when you open it, for up to 15 minutes. If you're already navigating, it goes into Recent instead of interrupting.

The page also explains an optional iPhone Shortcut so you can send straight from Apple Maps' **Share** button.

Messages go through [ntfy.sh](https://ntfy.sh), a free relay with no account needed. Your code is the private channel name, so press **New code** on the glasses any time to change it.

## If it can't find your location

Waypoint now keeps retrying by itself. If a location request is refused or goes quiet, it starts a fresh one within a second or two, then backs off gently, so you shouldn't ever need to press Try again. It only shows **Blocked** if location keeps being refused for more than 20 seconds.

The badge at the top of the home screen shows the location status: **±8 m** means it has a fix, **Locating…** means it's still looking, **Blocked** means permission is off, and **Phone loc** means it's borrowing your phone's position. Press the badge to see details: permission state, when the last fix arrived, and any error code.

The glasses get their location from your iPhone through the Meta AI app, so check:

1. Settings → Privacy & Security → **Location Services** is on
2. Settings → Apps → **Meta AI** → Location → **Always**, with **Precise Location** on
3. Settings → Apps → Meta AI → **Background App Refresh** is on
4. Bluetooth is on and the Meta AI app is running in the background

Even without a glasses fix, you can still navigate:
- Sending a place from the phone page also sends your phone's position, which Waypoint uses as the starting point.
- **Go** always works. If there's no location yet, navigation shows "Waiting for your location…" and plans the route the moment a fix arrives.

## Navigation services

| | Search | Routing | Account? |
|---|---|---|---|
| **Default** | [Photon](https://photon.komoot.io) (OpenStreetMap), with Nominatim as a fallback | [Valhalla](https://valhalla1.openstreetmap.de) public server (FOSSGIS) | None |
| **Optional** | Mapbox Search Box | Mapbox Directions (walking) | Free Mapbox account |

The free OpenStreetMap servers are community-run and meant for light personal use. Mapbox gives better place search (shops, businesses) and has a free tier that is plenty for one person.

**To switch to Mapbox:**

1. Sign up at [mapbox.com](https://account.mapbox.com/auth/signup/) and choose **Start without a credit card**.
2. On your account page, copy the **Default public token** (it starts with `pk.`).
3. On GitHub, open `config.js`, click the pencil, paste the token between the quotes on `MAPBOX_TOKEN: ""`, and commit.
4. Optional: in Mapbox → **Tokens**, create a token restricted to the URL `https://<you>.github.io/` and use that one instead.

Free monthly allowance: 50,000 searches and 100,000 routes, far more than one person uses.

You can change the other settings in `config.js` the same way: units (`metric` or `imperial`), language, voice on/off, the off-route distance and the arrival distance.

## Putting it on GitHub Pages (web interface)

1. Create a new **public** repository, e.g. `waypoint`.
2. **Add file → Upload files**, then drag in everything from this folder: `index.html`, `style.css`, `app.js`, `config.js`, `README.md`, the `icons` folder, `.nojekyll` and the `.well-known` folder.
   - macOS hides files whose names start with a dot. Press **Cmd + Shift + .** in Finder to show them before you drag.
   - If `.well-known` won't upload, use **Add file → Create new file** instead. Type `.well-known/meta-wearables-manifest.json` as the name, then paste in the file's contents. Do the same for an empty file called `.nojekyll`.
3. **Settings → Pages → Source: Deploy from a branch → main / (root) → Save.**
4. After a minute your app is live at `https://<you>.github.io/waypoint/`.
5. Load it on the glasses the same way as your other apps (Meta AI app Developer Mode → install link or QR code).

`.nojekyll` matters: without it, GitHub Pages hides the `.well-known` folder, and the glasses won't find the app's name and icon.

## Testing on a laptop

Open `https://<you>.github.io/waypoint/?demo` in Chrome. It starts you at Trafalgar Square and simulates walking along the route, so you can try search, routing, the turn prompts, re-planning and arrival without going outside. You can add `&start=LAT,LON` to start somewhere else and `&speed=10` to change the walking speed (metres per second). Use the arrow keys and Enter to stand in for the Neural Band.

## Files

```
index.html                              glasses screens
send.html                               phone companion page
search.js                               search engine (postcodes, categories, names, map links)
style.css                               styles for the additive display
app.js                                  search, routing, tracking, voice, mini map
config.js                               your settings (Mapbox token, units…)
icons/icon.svg                          monochrome app icon
icons/apple-touch-icon.png              iPhone Home Screen icon
.well-known/meta-wearables-manifest.json  name + icon for the glasses launcher
.nojekyll                               lets GitHub Pages serve .well-known
```

Map data © OpenStreetMap contributors.
