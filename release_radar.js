// ==UserScript==
// @name         Deezer Release Radar
// @namespace    Violentmonkey Scripts
// @version      1.1
// @author       Bababoiiiii
// @description  Adds a new button on the deezer page allowing you to see new releases of artists you follow.
// @icon         https://www.google.com/s2/favicons?sz=64&domain=deezer.com
// @match        https://www.deezer.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_addValueChangeListener
// ==/UserScript==

// TODO:
// artist blacklist by artist id
// setting for if to include featured songs

"use strict";

function log(...args) {
    console.log("[Deezer Release Radar]", ...args)
}

// data stuff

async function get_user_data() {
    // best to run this before doing anything else
    const r = await fetch("https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=", {
        "body": "{}",
        "method": "POST",
    });
    if (!r.ok) {
        return null;
    }
    const resp = await r.json();
    return resp;
}

async function get_auth_token() {
    const r = await fetch("https://auth.deezer.com/login/renew?jo=p&rto=c&i=c", {
        "method": "POST",
        "credentials": "include"
    });
    const resp = await r.json();
    return resp.jwt;
}

function get_all_followed_artists(user_id) {
    // we use _order since that returns a list and not a json object.
    // we sort the songs by release date anyways so the order of the artist does not matter
    return new Promise((resolve, reject) => {
        const wait_for_localstorage_data = setInterval(() => {
            let artists = localStorage.getItem("favorites_artist_order_" + user_id);
            if (artists) {
                clearInterval(wait_for_localstorage_data);
                resolve(JSON.parse(artists));
            }
        }, 10);
   });
}

async function get_amount_of_songs_of_album(api_token, album_id) {
    const r = await fetch("https://www.deezer.com/ajax/gw-light.php?method=song.getListByAlbum&input=3&api_version=1.0&api_token="+api_token, {
        "body": `{\"alb_id\":\"${album_id}\",\"start\":0,\"nb\":0}`,
        "method": "POST",
    });
    const resp = await r.json();
    return resp.results?.total;
}

async function get_releases(auth_token, artist_id, cursor=null) {
    const r = await fetch("https://pipe.deezer.com/api", {
        "headers": {
            "authorization": "Bearer "+auth_token,
            "Content-Type": "application/json"
        },
        "body": JSON.stringify({
            "operationName": "ArtistDiscographyByType",
            "variables": {
                "artistId": artist_id,
                "nb": Math.floor(config.max_song_age/2), // 1 song every 2 days to try to get as little songs as possible, but also try to avoid multiple requests
                "cursor": cursor,
                "subType": null,
                "roles": ["MAIN"],
                "order": "RELEASE_DATE",
                "types": ["EP", "SINGLES", "ALBUM"]
            },
            "query": "query ArtistDiscographyByType($artistId: String!, $nb: Int!, $roles: [ContributorRoles!]!, $types: [AlbumTypeInput!]!, $subType: AlbumSubTypeInput, $cursor: String, $order: AlbumOrder) {\n  artist(artistId: $artistId) {\n    albums(\n      after: $cursor\n      first: $nb\n      onlyCanonical: true\n      roles: $roles\n      types: $types\n      subType: $subType\n      order: $order\n    ) {\n      edges {\n        node {\n          ...AlbumBase\n        }\n      }\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n    }\n  }\n}\n\nfragment AlbumBase on Album {\n  id\n  displayTitle\n  releaseDate\n  cover {\n    ...PictureSmall\n  }\n  ...AlbumContributors\n}\n\nfragment PictureSmall on Picture {\n  small: urls(pictureRequest: {height: 56, width: 56})\n}\n\nfragment AlbumContributors on Album {\n  contributors {\n    edges {\n      node {\n        ... on Artist {\n          name\n        }\n      }\n    }\n  }\n}"
        }),
        "method": "POST",
    });
    const resp = await r.json();
    return [resp.data.artist.albums.edges, resp.data.artist.albums.pageInfo.endCursor.hasNextPage, resp.data.artist.albums.pageInfo.endCursor];
}

async function get_new_releases(auth_token, api_token, artist_ids) {
    const new_releases = [];
    const current_time = Date.now();
    const amount_of_songs_in_each_album_promises = [];

    async function process_artist_batch(batch_artist_ids) {
        const batch_promises = batch_artist_ids.map(async (artist_id) => {
            let [releases, next_page, cursor] = [null, true, null];

            while (next_page) {
                if (cursor) {
                    console.log("artist again", artist_id);
                }
                [releases, next_page, cursor] = await get_releases(auth_token, artist_id, cursor);

                for (let release of releases) {
                    release.node.releaseDate = new Date(release.node.releaseDate).getTime();

                    if (current_time - release.node.releaseDate > 1000 * 60 * 60 * 24 * config.max_song_age) {
                        break;
                    }

                    const new_release = {
                        artists: release.node.contributors.edges.map(e => e.node.name),
                        cover_img: release.node.cover.small[0],
                        name: release.node.displayTitle,
                        id: release.node.id,
                        release_date: release.node.releaseDate,
                    };

                    new_releases.push(new_release);

                    const amount_of_songs_in_album_promise = (async () => {
                        const amount_songs = await get_amount_of_songs_of_album(api_token, new_release.id);
                        new_release.amount_songs = amount_songs;
                    })();

                    amount_of_songs_in_each_album_promises.push(amount_of_songs_in_album_promise);
                }
            }
        });

        await Promise.all(batch_promises);
    }

    const batch_size = 10;
    for (let i = 0; i < artist_ids.length; i += batch_size) {
        const batch_artist_ids = artist_ids.slice(i, i + batch_size);
        await process_artist_batch(batch_artist_ids);
    }

    await Promise.all(amount_of_songs_in_each_album_promises);

    new_releases.sort((a, b) => b.release_date - a.release_date); // sort newest songs first

    return new_releases.slice(0, config.max_song_count);
}


function get_cache() {
    return GM_getValue("cache", {});
}

function set_cache(data) {
    GM_setValue("cache", data)
}

function get_config() {
    return GM_getValue("config", {
        update_cooldown_hours: 12,
        max_song_count: 25,
        max_song_age: 90,
        open_in_app: false
    });
}

function set_config(data) {
    GM_setValue("config", data);
}

function pluralize(string, amount) {
    return amount === 1 ? string : string+"s";
}

function pluralize(unit, value) {
  return value === 1 ? unit : `${unit}s`;
}

function time_ago(unix_timestamp, capitalize=false) {
    const difference = Date.now() - unix_timestamp;

    const milliseconds_in_a_second = 1000;
    const milliseconds_in_a_minute = 60 * milliseconds_in_a_second;
    const milliseconds_in_an_hour = 60 * milliseconds_in_a_minute;
    const milliseconds_in_a_day = 24 * milliseconds_in_an_hour;
    const milliseconds_in_a_week = 7 * milliseconds_in_a_day;
    const milliseconds_in_a_month = 30 * milliseconds_in_a_day; // approx
    const milliseconds_in_a_year = 365 * milliseconds_in_a_day;

    let time_ago;

    if (difference < milliseconds_in_a_minute) {
        time_ago = Math.floor(difference / milliseconds_in_a_second);
        return `${time_ago} ${pluralize(capitalize ? "Second": "second", time_ago)}`;
    }

    if (difference < milliseconds_in_an_hour) {
        time_ago = Math.floor(difference / milliseconds_in_a_minute);
        return `${time_ago} ${pluralize(capitalize ? "Minute" : "minute", time_ago)}`;
    }

    if (difference < milliseconds_in_a_day) {
        time_ago = Math.floor(difference / milliseconds_in_an_hour);
        return `${time_ago} ${pluralize(capitalize ? "Hour" : "hour", time_ago)}`;
    }

    if (difference < milliseconds_in_a_week) {
        time_ago = Math.floor(difference / milliseconds_in_a_day);
        return `${time_ago} ${pluralize(capitalize ? "Day" : "day", time_ago)}`;
    }

    if (difference < milliseconds_in_a_month) {
        time_ago = Math.floor(difference / milliseconds_in_a_week);
        return `${time_ago} ${pluralize(capitalize ? "Week" : "week", time_ago)}`;
    }

    if (difference < milliseconds_in_a_year) {
        time_ago = Math.floor(difference / milliseconds_in_a_month);
        return `${time_ago} ${pluralize(capitalize ? "Month": "month", time_ago)}`;
    }

    time_ago = Math.floor(difference / milliseconds_in_a_year);
    return `${time_ago} ${pluralize(capitalize ? "Year" : "year", time_ago)}`;
}

// data stuff end

// UI stuff

function set_css() {
    const css = `
.release_radar_main_btn {
    display: inline-flex;
    min-height: var(--tempo-sizes-size-m);
    min-width: var(--tempo-sizes-size-m);
    vertical-align: middle;
    justify-content: center;
    align-items: center;
    border-radius: 50%;
    fill: currentcolor;
}
.release_radar_main_btn:hover {
    background-color: var(--tempo-colors-background-neutral-tertiary-hovered);
}
.release_radar_main_btn svg path {
    fill: currentcolor;
}

.release_radar_main_btn svg circle {
    fill: grey;
}
.release_radar_main_btn.loading svg circle {
    fill: var(--tempo-colors-background-brand-flame);
    animation: load_pulse 2s infinite ease-in-out;;
}
@keyframes load_pulse {
    0%, 100% {
        filter: brightness(0.5);
    }
    50% {
        filter: brightness(1.5);
    }
}
.release_radar_main_btn.has_new svg circle {
    fill: red;
}

.release_radar_wrapper_div {
    position: absolute;
    transform: translate(-236px, 32px);
    z-index: 1;
    top: 34px;
}
.release_radar_wrapper_div.hide {
    display: none;
}

.release_radar_popper_div {
    background-color: var(--tempo-colors-background-neutral-secondary-default);
    box-shadow: var(--popper-shadow);
    color: var(--text-intermediate);
    width: 375px;
    overflow: hidden;
    border-radius: 10px;
}

.release_radar_main_div {
    max-height: 450px;
    overflow-y: auto;
}

.release_radar_main_div_arrow {
    width: 0;
    height: 0;
    border: 6px solid transparent;
    border-top-width: 0;
    border-bottom-color: var(--tempo-colors-background-neutral-secondary-default);
    top: -6px;
    left: 246px;
    position: absolute;
}

.release_radar_main_div_header_div {
    padding: 12px 24px;
    font-weight: var(--tempo-fontWeights-heading-m);
    font-size: var(--tempo-fontSizes-heading-m);
    line-height: var(--tempo-lineHeights-heading-m);
    border-bottom: 1px solid var(--tempo-colors-divider-main);
}

.release_radar_main_div_header_div button {
    position: relative;
    left: 45%;
    margin-left: 10px;
}
.release_radar_main_div_header_div button:hover {
    transform: scale(1.2);
}

.release_radar_main_div_header_div div {
    display: flex;
    margin-top: 10px;
    font-size: 11.5px;
    font-weight: normal
}

.release_radar_main_div_header_div div>label {
    display: flex;
    flex-direction: column;
    width: 31%;
    color: var(--tempo-colors-text-neutral-secondary-default);
    margin-right: 5px;
    cursor: text;
}

.release_radar_main_div_header_div div>label>input {
    background-color: var(--tempo-colors-background-neutral-tertiary-default);
    border: 1px var(--tempo-colors-border-neutral-primary-default) solid;
    border-radius: var(--tempo-radii-s);
    padding: 0px 5px;
}
.release_radar_main_div_header_div div input:hover {
    background-color: var(--tempo-colors-background-neutral-tertiary-hovered);
}
.release_radar_main_div_header_div div input:focus {
    border-color: var(--tempo-colors-border-neutral-primary-focused);
}
.release_radar_main_div_header_div div>label>input[type='checkbox'] {
    height: 25px;
}

.release_li {
    display: flex;
    flex-direction: column;
    background-color: var(--tempo-colors-background-neutral-secondary-default);
    position: relative;
    min-height: 32px;
    padding: 18px 16px 8px;
    border-bottom: 1px solid var(--tempo-colors-divider-main);
    transition-duration: .15s;
    transition-property: background-color, color;
    width: 100%;
}
.release_li:hover {
    background-color: var(--tempo-colors-bg-contrast);
}
.release_li img {
    border-radius: var(--tempo-radii-xs);
}
.release_li>div {
    display: inline-flex;
}

.release_radar_song_info_div {
    display: flex;
    flex-direction: column;
    height: 42px;
    padding-top: 7px;
    max-width: 80%;
}

.release_radar_song_info_div * {
    padding-left: 15px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}
.release_radar_song_info_div a {
    font-size: 16px;
}
.release_radar_song_info_div.is_new a::before {
    content: "";
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background-color: red;
    margin-right: 5px;
}

.release_radar_song_info_div div {
    color: var(--tempo-colors-text-neutral-secondary-default);
    font-size: 14px;
}

.release_radar_bottom_info_div {
    color: var(--tempo-colors-text-neutral-secondary-default);
    font-size: 12px;
    margin-top: 8px;
}

.release_radar_last_checked_span {
    font-size: 11px;
    color: var(--color-light-grey-800);
    padding: 5px 15px;
}

`;

    GM_addStyle(css);
}

function create_new_releases_divs(new_releases, main_btn) {
    function create_release_li(release) {
        const release_li = document.createElement("li");
        release_li.className = "release_li";

        const top_info_div = document.createElement("div");

        const release_img = document.createElement("img");
        release_img.src = release.cover_img;

        const song_info_div = document.createElement("div");
        song_info_div.className = "release_radar_song_info_div";

        const song_title_a = document.createElement("a");
        song_title_a.href = (config.open_in_app ? "deezer" : "https") + "://www.deezer.com/en/album/"+release.id;
        song_title_a.textContent = release.name;

        const artists_div = document.createElement("div");
        artists_div.textContent = release.artists.join(", ");

        song_info_div.append(song_title_a, artists_div);

        const bottom_info_div = document.createElement("div");
        bottom_info_div.className = "release_radar_bottom_info_div"
        bottom_info_div.textContent = `${(new Date(release.release_date)).toLocaleDateString()} (${time_ago(release.release_date)} ago) - ${release.amount_songs} ${pluralize("Song", release.amount_songs)}` ;

        if (!cache.has_seen[release.id]) {
            amount_new_songs++;
            main_btn.classList.toggle("has_new", true)

            song_info_div.classList.toggle("is_new", true);

            release_li.onmouseover = () => {
                release_li.onmouseover = null;
                amount_new_songs--;

                main_btn.classList.toggle("has_new", amount_new_songs > 0)
                song_info_div.classList.toggle("is_new", false);

                cache.has_seen[release.id] = true;
                set_cache(cache);
            }
        }

        top_info_div.append(release_img, song_info_div);

        release_li.append(top_info_div, bottom_info_div);
        return release_li;
    }

    let amount_new_songs = 0;
    return new_releases.map(r => create_release_li(r));
}

function create_main_div() {
    const wrapper_div = document.createElement("div");
    wrapper_div.className = "release_radar_wrapper_div hide";

    const arrow_div = document.createElement("div");
    arrow_div.className = "release_radar_main_div_arrow";

    const popper_div = document.createElement("div");
    popper_div.className = "release_radar_popper_div";

    const main_div = document.createElement("div");
    main_div.className = "release_radar_main_div"

    const header_wrapper_div = document.createElement("div");
    header_wrapper_div.className = "release_radar_main_div_header_div";
    const header_span = document.createElement("span");
    header_span.textContent = "New Releases";
    header_span.title = "Lists new releases from the artists you follow. The songs displayed are limited by either the maximum song age or the maximum song count limit (whichever kicks in first)."

    const settings_button = document.createElement("button");
    settings_button.textContent = "⚙";
    settings_button.title = "Settings";

    let show = false;
    let settings_wrapper;
    settings_button.onclick = () => {
        show = !show;
        if (!show) {
            settings_wrapper?.remove();
            return;
        }

        function create_setting(name, description, config_key) {
            const setting_label = document.createElement("label");
            setting_label.textContent = name;
            setting_label.title = description;

            const setting_input = document.createElement("input");
            setting_input.type = "number";
            setting_input.value = config[config_key];
            setting_input.onchange = () => {
                config[config_key] = setting_input.value;
                set_config(config);
            }

            setting_label.appendChild(setting_input);

            return setting_label;
        }

        settings_wrapper = document.createElement("div");

        const update_interval_label = create_setting("Update Cooldown", "The time inbetween scans for new songs (in hours).", "update_cooldown_hours");
        const max_song_label = create_setting("Max. Songs", "The maximum amount of songs displayed at once. Only applies after a new scan.", "max_song_count");
        const max_song_age_label = create_setting("Max. Song Age", "The maximum age of a displayed song (in days). This affects how many requests are made, so keep it low to avoid performance/error issues. Only applies after a new scan.", "max_song_age");

        const open_in_app_label = document.createElement("label");
        open_in_app_label.textContent = "App";
        open_in_app_label.title = "Open the links in the deezer desktop app.";

        const open_in_app_input = document.createElement("input");
        open_in_app_input.type = "checkbox";
        open_in_app_input.checked = config.open_in_app;
        open_in_app_input.onchange = () => {
            config.open_in_app = open_in_app_input.checked;
            set_config(config);
            main_div.querySelectorAll("a").forEach(a => a.href = a.href.replace(config.open_in_app ? "https" : "deezer", config.open_in_app ? "deezer" : "https"));
        }
        open_in_app_label.appendChild(open_in_app_input)

        settings_wrapper.append(update_interval_label, max_song_label, max_song_age_label, open_in_app_label);
        header_wrapper_div.append(settings_wrapper);
    }

    const reload_button = document.createElement("button");
    reload_button.textContent = "⟳";
    reload_button.title = "Scan for new songs. This reloads the page. Use after changing a setting.";
    reload_button.onclick = () => {
        cache[user_id].new_releases = [];
        cache[user_id].last_checked = 0;
        set_cache(cache);
        location.reload();
    }

    header_wrapper_div.append(header_span, reload_button, settings_button);

    const last_checked_span = document.createElement("span");
    last_checked_span.className = "release_radar_last_checked_span";


    popper_div.append(header_wrapper_div, main_div, last_checked_span);
    wrapper_div.append(popper_div, arrow_div);
    return [wrapper_div, main_div];
}

function create_main_btn(wrapper_div) {
    const parent_div = document.createElement("div");

    const main_btn = document.createElement("button");

    main_btn.className = "release_radar_main_btn loading";
    main_btn.innerHTML = `
    <svg viewBox="0 0 24 24" width="20px" height="20px">
        <path
            d="M12 3c-5.888 0-9 3.112-9 9 0 2.846.735 5.06 2.184 6.583l-1.448 1.379C1.92 18.055 1 15.376 1 12 1 5.01 5.01 1 12 1s11 4.01 11 11c0 3.376-.92 6.055-2.736 7.962l-1.448-1.379C20.266 17.061 21 14.846 21 12c0-5.888-3.112-9-9-9Z">
        </path>
        <path
            d="M18.5 11.89c0 2.049-.587 3.666-1.744 4.807l-1.404-1.424c.761-.752 1.148-1.89 1.148-3.383 0-2.986-1.514-4.5-4.5-4.5-2.986 0-4.5 1.514-4.5 4.5 0 1.483.38 2.615 1.133 3.367l-1.414 1.414C6.079 15.531 5.5 13.922 5.5 11.89c0-4.07 2.43-6.5 6.5-6.5s6.5 2.43 6.5 6.5Z">
        </path>
        <path
            d="M10.53 10.436c-.37.333-.53.856-.53 1.564 0 .714.168 1.234.537 1.564.325.292.805.436 1.463.436.719 0 1.219-.164 1.54-.496.32-.332.46-.832.46-1.504 0-.736-.211-1.269-.62-1.598-.332-.268-.795-.402-1.38-.402-.67 0-1.15.146-1.47.436ZM13 23v-7h-2v7h2Z">
        </path>
        <circle cx="20" cy="4" r="4"></circle>
    </svg>`

    parent_div.appendChild(main_btn);

    const last_checked_span = wrapper_div.querySelector("span.release_radar_last_checked_span");
    main_btn.onclick = () => {
        wrapper_div.classList.toggle("hide");
        if (!wrapper_div.classList.contains("hide")) {
            last_checked_span.textContent = `Last Update: ${time_ago(cache[user_id].last_checked)} ago`;
        }
    }
    return [parent_div, main_btn];
}


// globals
let ui_initialized = false;
const config = get_config();
let user_id;
let cache;

main();

async function main() {
    let parent_div = document.body.querySelector("#page_topbar");
    if (parent_div) {
        create_ui(parent_div);
    } else {
        const observer = new MutationObserver(mutations => {
            for (let mutation of mutations) {
                if (mutation.type === 'childList') {
                    parent_div = document.body.querySelector("#page_topbar");
                    if (parent_div) {
                        observer.disconnect();
                        create_ui(parent_div);
                    }
                }
            }
        });
        observer.observe(document.body, {childList: true, subtree: true});
    }

    log("Getting user data");
    const user_data = await get_user_data();

    user_id = user_data.results.USER.USER_ID;
    const api_token = user_data.results.checkForm;

    cache = get_cache();
    if (!cache.has_seen) cache.has_seen = {}

    let new_releases;

    // use cache if cache for this user exists and if the cache is not older than N hours
    if (cache[user_id] && Date.now() - cache[user_id].last_checked < config.update_cooldown_hours*60*60*1000) { // only update every N hours
        log("Checked earlier, using cache");
        new_releases = cache[user_id].new_releases;
    } else {
        log("Getting followed artists");
        const artist_ids = await get_all_followed_artists(user_id);

        log("Authenticating");
        const auth_token = await get_auth_token();

        log("Getting new releases")
        new_releases = await get_new_releases(auth_token, api_token, artist_ids);

        cache[user_id] = {
            last_checked: Date.now(),
            new_releases: new_releases
        }
        set_cache(cache);
    }

    console.log(new_releases);


    function create_ui(parent) {
        if (ui_initialized) {
            return;
        }
        ui_initialized = true;
        log("Parent found");
        set_css();

        const [wrapper_div, main_div] = create_main_div();
        const [parent_div, main_btn] = create_main_btn(wrapper_div);

        parent_div.append(wrapper_div);

        const wait_for_releases_data = setInterval(() => {
            log("Waiting for data");
            if (new_releases) {
                clearInterval(wait_for_releases_data);
                log("Got data");

                const new_releases_divs = create_new_releases_divs(new_releases, main_btn);
                main_div.append(...new_releases_divs);
                main_btn.classList.remove("loading");
            }
        }, 10);

        parent.querySelectorAll("div[class='popper-wrapper topbar-action']").forEach(e => e.addEventListener("click", (e) => {
            console.log(e);
            if (!event.keepOpen) {
                wrapper_div.classList.toggle("hide", true)
            }
        }))
        parent.insertBefore(parent_div, parent.querySelector("div:nth-child(2)"));
        log("UI initialized");
    }
}
