#!/usr/bin/env python3
import json
import math
import statistics
import sys
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

# Centered on SE24 0AQ postcode centroid from postcodes.io:
# latitude 51.460834, longitude -0.097488.
BBOX = (51.444, -0.124, 51.478, -0.071)
HOME = {"lat": 51.460834, "lon": -0.097488}
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OUT = Path("data/se24-objects.json")

FAMILIES = {
    "canopy": {
        "label": "Trees",
        "sets": ["Trees"],
        "types": {"tree"},
    },
    "memory": {
        "label": "History and art",
        "sets": ["History and art"],
        "types": {"memorial", "artwork", "place_of_worship"},
    },
    "street": {
        "label": "Street objects",
        "sets": ["Street objects"],
        "types": {"post_box", "bench", "waste_basket", "bicycle_parking", "telephone", "defibrillator", "toilets"},
    },
    "culture": {
        "label": "Places",
        "sets": ["Places"],
        "types": {"pub", "cafe", "restaurant", "fast_food", "library", "theatre", "gallery", "arts_centre", "community_centre"},
    },
    "movement": {
        "label": "Transport",
        "sets": ["Transport"],
        "types": {"bus_stop", "crossing", "traffic_signals"},
    },
}

TYPE_TO_FAMILY = {}
for family, config in FAMILIES.items():
    for type_name in config["types"]:
        TYPE_TO_FAMILY[type_name] = family

TYPE_LABELS = {
    "tree": "tree",
    "post_box": "postbox",
    "bench": "bench",
    "waste_basket": "waste basket",
    "bicycle_parking": "cycle parking",
    "telephone": "telephone box",
    "defibrillator": "defibrillator",
    "toilets": "public toilet",
    "memorial": "memorial",
    "artwork": "artwork",
    "place_of_worship": "place of worship",
    "pub": "pub",
    "cafe": "cafe",
    "restaurant": "restaurant",
    "fast_food": "food stop",
    "library": "library",
    "theatre": "theatre",
    "gallery": "gallery",
    "arts_centre": "arts centre",
    "community_centre": "community centre",
    "bus_stop": "bus stop",
    "crossing": "crossing",
    "traffic_signals": "traffic signals",
}


def build_query():
    south, west, north, east = BBOX
    tags = [
        'node["natural"="tree"]',
        'node["amenity"~"post_box|bench|waste_basket|bicycle_parking|telephone|defibrillator|toilets|pub|cafe|restaurant|fast_food|library|theatre|arts_centre|community_centre"]',
        'node["tourism"~"artwork|gallery"]',
        'node["historic"~"memorial"]',
        'node["highway"~"bus_stop|crossing|traffic_signals"]',
        'way["amenity"~"pub|cafe|restaurant|fast_food|library|theatre|arts_centre|community_centre"]',
        'way["tourism"~"artwork|gallery"]',
        'way["historic"~"memorial"]',
        'way["building"="church"]',
    ]
    bbox = f"({south},{west},{north},{east})"
    body = "\n".join(f"  {tag}{bbox};" for tag in tags)
    return f"[out:json][timeout:60];\n(\n{body}\n);\nout center tags;"


def fetch():
    data = urllib.parse.urlencode({"data": build_query()}).encode()
    request = urllib.request.Request(OVERPASS_URL, data=data, headers={"User-Agent": "se24-field-cards/0.1"})
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.loads(response.read().decode())


def detect_type(tags):
    if tags.get("natural") == "tree":
        return "tree"
    if tags.get("historic") == "memorial":
        return "memorial"
    if tags.get("tourism") in {"artwork", "gallery"}:
        return "artwork" if tags.get("tourism") == "artwork" else "gallery"
    if tags.get("building") == "church":
        return "place_of_worship"
    amenity = tags.get("amenity")
    if amenity in TYPE_TO_FAMILY:
        return amenity
    highway = tags.get("highway")
    if highway in TYPE_TO_FAMILY:
        return highway
    return None


def element_point(element):
    if "lat" in element and "lon" in element:
        return element["lat"], element["lon"]
    center = element.get("center")
    if center:
        return center["lat"], center["lon"]
    return None


def clean_name(tags, type_name, index):
    for key in ("name", "official_name", "operator", "brand", "ref"):
        value = tags.get(key)
        if value:
            return value.strip()
    return f"{TYPE_LABELS.get(type_name, type_name).title()} #{index}"


def meters(a, b):
    lat = (a["lat"] - b["lat"]) * 111_320
    lon = (a["lon"] - b["lon"]) * 69_400
    return math.hypot(lat, lon)


def percentile(values, value, inverse=False):
    if not values:
        return 50
    below = sum(1 for item in values if item <= value)
    score = round(100 * below / len(values))
    return 100 - score if inverse else score


def clamp(value, low=8, high=98):
    return max(low, min(high, round(value)))


def normalise(raw):
    records = []
    seen = set()
    for index, element in enumerate(raw.get("elements", []), start=1):
        tags = element.get("tags", {})
        type_name = detect_type(tags)
        point = element_point(element)
        if not type_name or not point:
            continue
        family = TYPE_TO_FAMILY[type_name]
        lat, lon = point
        key = (round(lat, 6), round(lon, 6), type_name, clean_name(tags, type_name, index).lower())
        if key in seen:
            continue
        seen.add(key)
        records.append(
            {
                "sourceId": f"osm-{element['type']}-{element['id']}",
                "lat": lat,
                "lon": lon,
                "type": type_name,
                "typeLabel": TYPE_LABELS.get(type_name, type_name),
                "family": family,
                "familyLabel": FAMILIES[family]["label"],
                "name": clean_name(tags, type_name, index),
                "tags": tags,
                "source": "OpenStreetMap via Overpass API",
            }
        )
    return records


def enrich(records):
    type_counts = Counter(item["type"] for item in records)
    species_counts = Counter(tree_species(item) for item in records if item["type"] == "tree")
    nearest_same = {}
    neighbour_counts = {}
    cross_counts = {}

    for item in records:
        distances_same = [meters(item, other) for other in records if other is not item and other["type"] == item["type"]]
        nearest_same[item["sourceId"]] = min(distances_same) if distances_same else 700
        neighbour_counts[item["sourceId"]] = sum(1 for other in records if other is not item and meters(item, other) <= 90)
        cross_counts[item["sourceId"]] = len({other["family"] for other in records if other is not item and meters(item, other) <= 140})

    nearest_values_by_type = defaultdict(list)
    neighbour_values = list(neighbour_counts.values())
    for item in records:
        nearest_values_by_type[item["type"]].append(nearest_same[item["sourceId"]])

    enriched = []
    for item in records:
        type_rarity = 100 - percentile(list(type_counts.values()), type_counts[item["type"]])
        name_bonus = 18 if item["tags"].get("name") else 0
        local_isolation = percentile(nearest_values_by_type[item["type"]], nearest_same[item["sourceId"]])
        density = percentile(neighbour_values, neighbour_counts[item["sourceId"]])
        context = clamp((cross_counts[item["sourceId"]] / 5) * 100 + name_bonus)
        story = story_score(item)
        rarity = clamp((type_rarity * 0.45) + (local_isolation * 0.35) + (name_bonus * 0.9) + 20)
        total = clamp((rarity * 0.34) + (density * 0.18) + (context * 0.24) + (story * 0.24), 1, 100)
        value = field_value(
            item,
            local_isolation,
            nearest_same[item["sourceId"]],
            neighbour_counts[item["sourceId"]],
            cross_counts[item["sourceId"]],
            type_counts[item["type"]],
            species_counts[tree_species(item)] if item["type"] == "tree" else 0,
        )
        rarity_name, rarity_rank = rarity_for_value(value)
        item.update(
            {
                "id": item["sourceId"].replace("osm-", ""),
                "distanceFromHome": round(meters(item, HOME)),
                "scores": {
                    "rarity": rarity,
                    "density": clamp(density),
                    "context": context,
                    "story": story,
                },
                "totalScore": total,
                "tier": rarity_name,
                "traits": traits_for(item, local_isolation, neighbour_counts[item["sourceId"]], cross_counts[item["sourceId"]]),
            }
        )
        item["game"] = game_for(
            item,
            rarity_name,
            rarity_rank,
            value,
            local_isolation,
            nearest_same[item["sourceId"]],
            neighbour_counts[item["sourceId"]],
            cross_counts[item["sourceId"]],
            type_counts[item["type"]],
            species_counts[tree_species(item)] if item["type"] == "tree" else 0,
        )
        item["sets"] = sets_for(item)
        enriched.append(item)

    by_family = defaultdict(list)
    for item in enriched:
        by_family[item["family"]].append(item)
    for family_items in by_family.values():
        for item in family_items:
            better_candidates = [candidate for candidate in family_items if candidate["game"]["value"] > item["game"]["value"]]
            better_candidates.sort(key=lambda candidate: (meters(item, candidate) > 700, meters(item, candidate), -candidate["game"]["value"]))
            better = better_candidates[0] if better_candidates else None
            item["game"]["hunt"] = hunt_line(item, better)

    return sorted(enriched, key=lambda item: item["totalScore"], reverse=True)


def prelimit(records):
    limits = {
        "tree": 220,
        "crossing": 120,
        "traffic_signals": 80,
        "bus_stop": 90,
        "bench": 90,
        "bicycle_parking": 80,
        "post_box": 80,
        "waste_basket": 80,
    }
    by_type = defaultdict(list)
    for item in records:
        by_type[item["type"]].append(item)

    selected = []
    for type_name, items in by_type.items():
        limit = limits.get(type_name, 70)
        items.sort(
            key=lambda item: (
                0 if item["tags"].get("name") else 1,
                meters(item, HOME),
                item["sourceId"],
            )
        )
        selected.extend(items[:limit])
    return selected


def tree_species(item):
    if item["type"] != "tree":
        return ""
    species = item["tags"].get("species:en") or item["tags"].get("species") or item["tags"].get("genus")
    return clean_value(species.split(";")[0]).lower() if species else "unidentified"


def field_value(item, isolation, nearest_same, neighbours, cross, type_count, species_count):
    tags = item["tags"]
    if item["family"] == "canopy":
        value = 1
        if tree_species(item) != "unidentified" and species_count < 25:
            value += 2
        if species_count <= 3 and tree_species(item) != "unidentified":
            value += 5
        if isolation > 85 or nearest_same >= 30:
            value += 1
        return min(value, 12)

    if item["family"] == "memory":
        if item["type"] == "artwork" and tags.get("artist_name") == "Maggi Hambling":
            return 200
        if item["type"] == "artwork" and tags.get("artist_name") and tags.get("start_date"):
            return 120
        if item["type"] == "artwork" and tags.get("artist_name"):
            return 80
        if tags.get("wikipedia") or tags.get("wikidata"):
            return 70
        if tags.get("name"):
            return 35
        return 12

    if item["family"] == "culture":
        if item["type"] == "library":
            return 100
        if item["type"] in {"theatre", "arts_centre", "gallery"}:
            return 70
        if tags.get("wikipedia") or tags.get("wikidata"):
            return 45
        if item["type"] in {"pub", "community_centre"}:
            return 15
        if tags.get("cuisine"):
            return 6
        return 4

    if item["family"] == "street":
        if item["type"] == "toilets":
            return 20
        if item["type"] == "post_box" and tags.get("ref"):
            return 5
        if item["type"] == "telephone":
            return 8
        if item["type"] == "defibrillator":
            return 25
        if item["type"] == "bicycle_parking" and tags.get("capacity"):
            capacity = int(tags["capacity"]) if tags["capacity"].isdigit() else 0
            return 3 + min(capacity // 20, 5)
        if item["type"] == "bench":
            return 2
        return 1

    if item["family"] == "movement":
        if item["type"] == "bus_stop" and tags.get("name"):
            return 3
        if item["type"] == "traffic_signals":
            return 2
        return 1

    return 1


def story_score(item):
    tags = item["tags"]
    score = 20
    for key in ("name", "species", "species:en", "genus", "brand", "operator", "network", "artist_name", "inscription", "wikidata", "wikipedia", "heritage", "ref", "collection_times"):
        if tags.get(key):
            score += 8
    if item["type"] in {"memorial", "artwork", "library", "theatre", "place_of_worship"}:
        score += 16
    return clamp(score)


def rarity_for_value(value):
    if value >= 100:
        return "Landmark", 5
    if value >= 25:
        return "Prize find", 4
    if value >= 10:
        return "Good find", 3
    if value >= 3:
        return "Useful find", 2
    return "Everyday", 1


def traits_for(item, isolation, neighbours, cross):
    tags = item["tags"]
    traits = [item["typeLabel"].title()]
    if tags.get("species:en") or tags.get("species"):
        traits.append((tags.get("species:en") or tags.get("species")).split(";")[0][:28])
    if tags.get("brand"):
        traits.append(tags["brand"][:28])
    if tags.get("operator"):
        traits.append(tags["operator"][:28])
    if isolation > 75:
        traits.append("less common nearby")
    if neighbours >= 12:
        traits.append("cluster")
    if cross >= 3:
        traits.append("near other types")
    if tags.get("wheelchair") == "yes":
        traits.append("accessible")
    return traits[:6]


def sets_for(item):
    sets = list(FAMILIES[item["family"]]["sets"])
    if item["tier"] in {"Prize find", "Landmark"}:
        sets.append("Prize Finds")
    if item["scores"]["context"] >= 70:
        sets.append("Layered Corners")
    if item["game"]["value"] >= 25:
        sets.append("Scarce Specimens")
    return sets


def game_for(item, rarity_name, rarity_rank, value, isolation, nearest_same, neighbours, cross, type_count, species_count):
    badges = badges_for(item, isolation, neighbours, cross, type_count, species_count)
    return {
        "rarity": rarity_name,
        "rarityRank": rarity_rank,
        "value": value,
        "kind": kind_for(item),
        "form": form_for(item),
        "why": why_line(item, isolation, nearest_same, neighbours, cross, type_count, species_count),
        "spot": spot_line(item),
        "hunt": "Find a higher value item from the same category.",
        "badges": badges,
    }


def kind_for(item):
    tags = item["tags"]
    if item["family"] == "canopy":
        species = item["tags"].get("species:en") or item["tags"].get("species")
        if species:
            return f"{species.split(';')[0]} tree"
        if tags.get("leaf_type"):
            return f"{tags['leaf_type']} tree"
        return "unidentified street tree"
    if item["family"] == "memory":
        if item["type"] == "artwork" and tags.get("artwork_type"):
            return tags["artwork_type"]
        if item["type"] == "place_of_worship":
            return "place of worship"
        return item["typeLabel"]
    if item["family"] == "street":
        if item["type"] == "bicycle_parking" and tags.get("bicycle_parking") == "shed":
            return "bikehangar"
        if item["type"] == "post_box" and tags.get("ref"):
            return "numbered postbox"
        return item["typeLabel"]
    if item["family"] == "culture":
        if tags.get("cuisine"):
            return f"{clean_value(tags['cuisine'].split(';')[0])} {item['typeLabel']}"
        return item["typeLabel"]
    if item["type"] == "traffic_signals":
        return "signalised crossing"
    return item["typeLabel"]


def form_for(item):
    labels = {
        "canopy": "Tree",
        "memory": "History/art",
        "street": "Street object",
        "culture": "Place",
        "movement": "Transport",
    }
    return labels[item["family"]]


def badges_for(item, isolation, neighbours, cross, type_count, species_count):
    tags = item["tags"]
    badges = [item["typeLabel"].title()]
    if type_count <= 3:
        badges.append(f"only {type_count} nearby")
    if tags.get("name"):
        badges.append("named")
    if tags.get("species:en") or tags.get("species"):
        if species_count >= 25:
            badges.append("common species")
        else:
            badges.append("species recorded")
    if tags.get("artist_name"):
        badges.append("artist known")
    if tags.get("start_date"):
        badges.append(tags["start_date"])
    if tags.get("wikidata") or tags.get("wikipedia"):
        badges.append("public record")
    if tags.get("ref"):
        badges.append(f"ref {tags['ref']}"[:28])
    if tags.get("collection_times"):
        badges.append("collection clue")
    if tags.get("operator") or tags.get("brand"):
        badges.append((tags.get("operator") or tags.get("brand"))[:28])
    if isolation > 75:
        badges.append("less common nearby")
    if neighbours >= 12:
        badges.append("cluster")
    if cross >= 3:
        badges.append("near other types")
    return dedupe(badges)[:6]


def why_line(item, isolation, nearest_same, neighbours, cross, type_count, species_count):
    tags = item["tags"]
    if item["family"] == "canopy":
        species = tags.get("species:en") or tags.get("species")
        if species:
            species_name = species.split(";")[0]
            if species_count >= 25:
                return f"{species_name} is common in this area, so this tree is low value."
            return f"The species is recorded as {species_name}. Less common species are worth more."
        if isolation > 75:
            return f"It is about {round(nearest_same)}m from the nearest mapped tree of the same kind."
        if neighbours >= 12:
            return "It is in a cluster of mapped trees."
        return "This is an ordinary mapped tree."
    if item["family"] == "memory":
        if tags.get("artist_name") and tags.get("start_date"):
            return f"It has both an artist and date: {tags['artist_name']} / {tags['start_date']}."
        if tags.get("artist_name"):
            return f"The artist is recorded as {tags['artist_name']}."
        if tags.get("wikipedia") or tags.get("wikidata"):
            return "It has a public reference link."
        if tags.get("name"):
            return "It has a recorded name."
        return "It is a mapped history or art object."
    if item["family"] == "street":
        if item["type"] == "toilets":
            return "Public toilets are uncommon and useful."
        if item["type"] == "post_box" and tags.get("ref"):
            return f"It has a postbox reference: {tags['ref']}."
        if item["type"] == "bicycle_parking" and tags.get("capacity"):
            return f"It has mapped capacity for {tags['capacity']} bikes."
        if tags.get("material"):
            return f"The mapped material is {tags['material']}."
        if type_count <= 3:
            return f"There are only {type_count} mapped {plural(item['typeLabel'])} in this slice."
        return "This is an ordinary mapped street object."
    if item["family"] == "culture":
        if item["type"] == "library":
            return "Libraries are high value because they are public, useful and uncommon."
        if tags.get("wikipedia") or tags.get("wikidata"):
            return "It has a public reference link."
        if tags.get("cuisine"):
            return f"The mapped cuisine is {clean_value(tags['cuisine'].split(';')[0])}."
        if type_count <= 3:
            return f"There are only {type_count} mapped {plural(item['typeLabel'])} in this slice."
        return "This is a mapped place open to the public."
    if item["type"] == "bus_stop" and tags.get("name"):
        return f"The bus stop name is {tags['name']}."
    if item["type"] == "traffic_signals":
        return "Traffic signals are worth a little more than a basic crossing."
    if cross >= 3:
        return "There are several other mapped objects nearby."
    return "This is an ordinary mapped movement point."


def spot_line(item):
    tags = item["tags"]
    parts = []
    address = address_line(tags)
    if address:
        parts.append(address)
    if tags.get("operator"):
        parts.append(f"operator: {tags['operator']}")
    if tags.get("brand") and tags.get("brand") != tags.get("name"):
        parts.append(f"brand: {tags['brand']}")
    if tags.get("ref"):
        parts.append(f"look for ref {tags['ref']}")
    if tags.get("species:en"):
        parts.append(f"species clue: {tags['species:en']}")
    if tags.get("opening_hours"):
        parts.append("opening hours are mapped")
    if tags.get("wheelchair") == "yes":
        parts.append("mapped as wheelchair accessible")
    if not parts:
        parts.append(f"about {round(meters(item, HOME))}m from SE24 0AQ")
    return "; ".join(parts[:3]) + "."


def address_line(tags):
    street = tags.get("addr:street") or tags.get("addr:place")
    number = tags.get("addr:housenumber")
    if street and number:
        return f"{number} {street}"
    if street:
        return street
    return None


def hunt_line(item, better):
    if better:
        return f"Next hunt: {better['name']} is a +{better['game']['value']} {better['game']['kind']} about {round(meters(item, better))}m away."
    return f"No higher value {item['game']['form'].lower()} nearby. Try another category."


def plural(label):
    if label.endswith("y"):
        return label[:-1] + "ies"
    if label.endswith("s"):
        return label
    return label + "s"


def clean_value(value):
    return value.replace("_", " ").strip()


def article(word):
    return "an" if word[:1].lower() in {"a", "e", "i", "o", "u"} else "a"


def dedupe(values):
    result = []
    seen = set()
    for value in values:
        key = value.lower()
        if key not in seen:
            seen.add(key)
            result.append(value)
    return result


def trim(records):
    by_family = defaultdict(list)
    for item in records:
        by_family[item["family"]].append(item)
    selected = []
    limits = {"canopy": 55, "memory": 35, "street": 65, "culture": 55, "movement": 55}
    for family, items in by_family.items():
        items.sort(key=lambda item: (item["distanceFromHome"], -item["game"]["value"], item["sourceId"]))
        selected.extend(items[: limits.get(family, 40)])
    return sorted(selected, key=lambda item: (item["distanceFromHome"], -item["game"]["value"], item["sourceId"]))


def main():
    try:
        raw = fetch()
    except Exception as exc:
        print(f"Fetch failed: {exc}", file=sys.stderr)
        return 1
    records = trim(enrich(prelimit(normalise(raw))))
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "generatedBy": "tools/fetch_se24_data.py",
                "source": "OpenStreetMap via Overpass API",
                "bbox": BBOX,
                "objectCount": len(records),
                "objects": records,
            },
            indent=2,
        )
    )
    print(f"Wrote {len(records)} objects to {OUT}")
    print(Counter(item["family"] for item in records))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
