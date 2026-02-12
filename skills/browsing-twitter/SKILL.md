---
name: browsing-twitter
description: "MUST be used when you need to read or interact with Twitter/X. Uses the bird CLI to read tweets, search, view threads, check mentions, post tweets, and reply - all through Michael's authenticated account. Bypasses X API restrictions. Triggers on: read tweet, twitter, X post, tweet URL, check twitter, search twitter, twitter thread, mentions, post tweet, reply to tweet, twitter timeline, who tweeted, what did they say on twitter."
---

# Browsing Twitter/X

Use the `bird` CLI to interact with Twitter/X through Michael's authenticated Chrome session. This bypasses API restrictions since it uses browser cookies.

## When to Use

- Read a tweet by URL or ID
- Search for tweets on a topic
- View a full thread/conversation
- Check mentions or replies
- Post a new tweet
- Reply to an existing tweet
- View someone's timeline
- Check bookmarks or likes

## Reading Tweets

### Read a single tweet

```bash
bird read <tweet-url-or-id>
```

Example:

```bash
bird read https://x.com/username/status/1234567890
bird read 1234567890
```

### Read a full thread

```bash
bird thread <tweet-url-or-id>
```

### View replies to a tweet

```bash
bird replies <tweet-url-or-id>
```

## Searching

### Search tweets

```bash
bird search "query"
bird search "from:username keyword"
bird search "#hashtag"
```

Options:

- `--limit <n>` - Number of results (default: 20)

## User Content

### Get someone's tweets

```bash
bird user-tweets <handle>
bird user-tweets elonmusk --limit 10
```

### Check mentions

```bash
bird mentions                    # Your mentions
bird mentions --user <handle>    # Someone else's mentions
```

### View timeline

```bash
bird home                        # Your "For You" feed
bird home --limit 20
```

### View bookmarks

```bash
bird bookmarks
```

### View likes

```bash
bird likes
```

## Posting

### Post a new tweet

```bash
bird tweet "Your tweet text here"
```

### Reply to a tweet

```bash
bird reply <tweet-id-or-url> "Your reply text"
```

### Post with media

```bash
bird tweet "Check this out" --media /path/to/image.png
bird tweet "Multiple images" --media img1.png --media img2.png
```

### Add alt text to media

```bash
bird tweet "Accessible tweet" --media photo.jpg --alt "Description of the image"
```

## Following

### Follow a user

```bash
bird follow <username>
```

### Unfollow a user

```bash
bird unfollow <username>
```

### See who you follow

```bash
bird following
bird following --user <handle>  # Who someone else follows
```

### See your followers

```bash
bird followers
bird followers --user <handle>  # Someone else's followers
```

## Account Info

### Check current account

```bash
bird whoami
```

### Get info about a user

```bash
bird about <username>
```

## Output Options

| Flag                | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `--plain`           | Plain output (no emoji, no color) - good for parsing |
| `--no-emoji`        | Disable emoji                                        |
| `--no-color`        | Disable ANSI colors                                  |
| `--quote-depth <n>` | Max quoted tweet depth (default: 1)                  |

## Examples

### Read and summarize a tweet

```bash
bird read https://x.com/theonejvo/status/2015892980851474595
```

### Find recent tweets about a topic

```bash
bird search "Claude AI" --limit 10
```

### Check what someone's been posting

```bash
bird user-tweets anthroploic --limit 5
```

### Reply to a tweet

```bash
bird reply 1234567890 "Great thread! Thanks for sharing."
```

## Viewing Images in Tweets

The plain text output doesn't show images, but JSON output includes media URLs.

### Get image URLs from a tweet

```bash
bird read <url> --json | jq '.media'
```

Returns:

```json
[
  {
    "type": "photo",
    "url": "https://pbs.twimg.com/media/xxxxx.png",
    "width": 665,
    "height": 407
  }
]
```

### To actually view images

1. Get the URL: `bird read <url> --json | jq -r '.media[0].url'`
2. Download: `curl -sL "<url>" -o /tmp/tweet-image.png`
3. View with Read tool: `Read /tmp/tweet-image.png`

### Quick one-liner to download all images

```bash
bird read <url> --json | jq -r '.media[].url' | while read url; do
  curl -sL "$url" -o "/tmp/tweet-$(basename $url)"
done
```

## Notes

- Uses Michael's Chrome session cookies - no API key needed
- Bypasses X's restrictions on unauthenticated access
- Rate limits are browser-based, not API-based
- All interactions appear as Michael's account
- For posting, be mindful this is Michael's real account
