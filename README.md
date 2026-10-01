# Waypoint

Walking turn-by-turn navigation for **Meta Ray-Ban Display** glasses. It shows a big turn arrow, the distance and the street name, with a heads-up mini map of your route underneath and spoken prompts.

Built from the [Meta Wearables Web Apps docs](https://wearables.developer.meta.com/docs/develop/webapps): 600×600 additive display (black is see-through), Neural Band arrow and Enter keys, phone-sourced `navigator.geolocation`, `DeviceOrientation` compass, and `speechSynthesis` for voice.

## Using it on the glasses

| Screen | Controls |
|---|---|
| Home | Select **Where to?** and say or write a place, address or postcode. Saved and Recent places sit underneath. |
| Results | Swipe up/down, then pinch to pick one. |
| Route | Shows walk time, distance and arrival time. **Go** starts navigation. **☆ Save** adds the place to Saved. |
| Navigating | **Left/Right** previews earlier or later turns (it snaps back after 8 seconds). **Up/Down** zooms the map. **Pinch** opens the menu: Resume, Voice on/off, Map facing-up or north-up, Re-plan route, End route. Back also opens the menu, so you can't end a route by accident. |

If you go off the route by more than about 30 m, it plans a new one for you.

## Navigation services

| | Search | Routing | Account? |
|---|---|---|---|
| **Default** | [Photon](https://photon.komoot.io) (OpenStreetMap), with Nominatim as a fallback | [Valhalla](https://valhalla1.openstreetmap.de) public server (FOSSGIS) | None |
| **Optional** | Mapbox Search Box | Mapbox Directions (walking) | Free Mapbox account |

The free OpenStreetMap servers are community-run and meant for light personal use. Mapbox gives better place search (shops, businesses) and has a free tier that is plenty for one person.

**To switch to Mapbox:** create a free account at mapbox.com, copy your *default public token* (it starts with `pk.`), then on GitHub open `config.js`, click the pencil, paste it between the quotes on `MAPBOX_TOKEN: ""`, and commit. In your Mapbox token settings you can restrict the token to your `https://<you>.github.io` URL.

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
index.html                              screens
style.css                               styles for the additive display
app.js                                  search, routing, tracking, voice, mini map
config.js                               your settings (Mapbox token, units…)
icons/icon.svg                          monochrome app icon
.well-known/meta-wearables-manifest.json  name + icon for the glasses launcher
.nojekyll                               lets GitHub Pages serve .well-known
```

Map data © OpenStreetMap contributors.
