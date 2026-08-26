# Creature portraits

For local use only, place square PNG portraits here using the creature display ID as the filename:

```text
portraits/19723.png
```

`SimpleScene` loads these files lazily from `UNIT_FIELD_DISPLAYID` and keeps the generated silhouette when a portrait is absent. Add every available numeric ID to `index.json` so missing portraits do not generate HTTP requests.

Portrait PNGs are ignored by Git and removed from production `dist/web`. They may be derived from
the user's own original client and must not be committed, redistributed or publicly hosted.
