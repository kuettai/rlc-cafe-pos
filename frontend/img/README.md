Menu item photos live in `menu/`, named `<slug>.png` — the slug `app.js` derives
from the menu item name. A missing file is hidden by the `onerror` handler rather
than showing a broken image, so an item without a photo degrades quietly.

There is no payment QR here on purpose: the café's DuitNow QR is physical,
printed on the tables, and the app never renders one.
