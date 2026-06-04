# Recipe Draft — Review & Adjust

This is a guesstimate for missing/incomplete recipes. Please review quantities and correct where needed.

## Key for Recipe Structure

- **default** = base recipe (applies to all variants unless overridden)
- **hot** = variant overlay (adds/overrides on top of default)
- **iced** = variant overlay (adds ice, same base)
- **oat** = variant overlay (replaces milk with oat milk)

Overlays MERGE with default: variant ingredient overrides same ingredient from default, adds new ones.

---

## Missing Recipes

### 🫖 Chai Latte (`87d184f1-23ff-4cc5-8448-2c3083949e4c`)

No chai latte powder is in our ingredient list yet. Need to add it.

**New ingredient needed:** Chai Latte Powder (unit: bags, usageUnit: g)

| Variant | Ingredient | Quantity | Unit |
|---------|-----------|----------|------|
| default | Chai Latte Powder | 20 | g |
| default | Milk (Fresh) | 150 | ml |
| default | Sugar Syrup | 10 | ml |
| iced | Ice | 5 | pieces |
| oat | Oat Milk | 150 | ml |

> Note: Chai powder from SOP stock-check exists ("Chai latte powder"). Was it already added? If not, need to create ingredient first.

---

### 🫖 Fruit Tea (`b3e9054a-97d2-41bb-9a49-0e06eba3a357`)

From the church recipe: "Steep English breakfast tea 5 min (100ml), 2 tablespoons citron paste, ice, top up with soda water"

**New ingredients needed:**
- English Breakfast Tea (unit: bags, usageUnit: bags) — 1 tea bag per drink
- Citron Paste (unit: bottles, usageUnit: spoons) — 2 spoons per drink

| Variant | Ingredient | Quantity | Unit |
|---------|-----------|----------|------|
| default | English Breakfast Tea | 1 | bags |
| default | Citron Paste | 2 | spoons |
| default | Sparkling Water | 150 | ml |
| default | Ice | 5 | pieces |

---

## Incomplete Variant Recipes (Missing Iced/Hot Overlays)

Currently most drinks only have a `default` recipe. Iced variants need ice added. Hot variants are same as default (no overlay needed — hot IS the default).

### All Espresso Drinks — Add `iced` Variant

| Drink | Variant | Add Ingredient | Quantity | Unit |
|-------|---------|---------------|----------|------|
| ☕ Latte | iced | Ice | 5 | pieces |
| ☕ Americano | iced | Ice | 5 | pieces |
| 🍫 Mocha | iced | Ice | 5 | pieces |
| 🍫 Hot Chocolate | iced | Ice | 5 | pieces |
| 🍵 Matcha Latte | iced | Ice | 5 | pieces |
| 🫖 Chai Latte | iced | Ice | 5 | pieces |

> Note: Latte `iced` already exists with 5 ice. Others need to be added.

---

## Existing Recipes — Verify Quantities

These are already seeded. Please check if quantities match your actual usage:

### ☕ Latte (default)
- Coffee Beans: 17g ← *correct? SOP says 16-18g*
- Milk (Fresh): 150ml ← *correct? or closer to 180ml?*

### ☕ Americano (default)
- Coffee Beans: 17g ← *just espresso + water, no milk tracked*

### 🍫 Mocha (default)
- Coffee Beans: 17g
- Chocolate Powder: 25g ← *from recipe doc*
- Milk (Fresh): 120ml ← *less than latte since chocolate takes volume?*

### 🍫 Hot Chocolate (default)
- Chocolate Powder: 25g
- Milk (Fresh): 150ml ← *no coffee, full milk*

### 🍵 Matcha Latte (default)
- Matcha Powder: 4g ← *correct? some cafés use 2-3g*
- Milk (Fresh): 150ml

### 🦋 Butterfly Pea Soda (default)
- Nata de Coco: 2 spoons
- Sprite: 200ml
- Butterfly Pea Tea: 5 (pumps? g? — *currently usageUnit=g but recipe says "4-5 pumps"*)
- Lemon Juice: 15ml ← *recipe says "3 squeezes"*

### 🍋 Lemon Soda (default)
- Monin Lemon Syrup: 20ml ← *recipe says "2 pumps" (~10ml each)*
- Sparkling Water: 200ml

### 🧃 Passion Fruit Soda (default)
- Monin Passion Fruit Syrup: 20ml
- Sparkling Water: 200ml

### 🍊 Orange Soda (default)
- Monin Orange Fruitmix: 30ml ← *from recipe doc*
- Sparkling Water: 200ml

### 🍋 Citrus Black (default)
- Monin Orange Fruitmix: 20ml
- Monin Passion Fruit Syrup: 10ml
- Sparkling Water: 150ml
- Coffee Beans: 17g (espresso shot)

### 🍇 Ribena Tonic (default)
- Tonic Water: 200ml
- *(Missing: Ribena ~30ml — not in ingredient list)*

### 🫐 Raspberry Iced Tea (default)
- Sprite: 150ml
- *(Missing: Raspberry Syrup ~30ml — not in ingredient list)*
- *(Missing: English Breakfast Tea — 1 bag)*

---

## New Ingredients to Add

Based on the gaps above, these ingredients should be created:

| Name | Stock Unit | Usage Unit | Storage |
|------|-----------|------------|---------|
| Chai Latte Powder | bags | g | STOREROOM |
| English Breakfast Tea | boxes | bags | STOREROOM |
| Citron Paste | bottles | spoons | FRIDGE |
| Ribena | bottles | ml | STOREROOM |
| Raspberry Syrup | bottles | ml | STOREROOM |

---

## Questions for Review

1. **Butterfly Pea Tea** — is the usage unit `pumps` or `g`? The recipe says "4-5 pumps" but we stored it as grams.
2. **Ice** — is 5 pieces per iced drink correct? Or is it more like "fill cup with ice" (volume-based)?
3. **Lemon Juice "3 squeezes"** — I estimated 15ml (5ml per squeeze). Correct?
4. **Chai Latte Powder** — how much per cup? I guessed 20g but chai mixes vary a lot.
5. **Ribena Tonic** — recipe says 30ml Ribena. Should we track Ribena separately or just track tonic water?
6. **Raspberry Iced Tea** — should we add raspberry syrup as a new ingredient?
