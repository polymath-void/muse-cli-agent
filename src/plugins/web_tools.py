import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET

def weather_fetcher(location):
    location = urllib.parse.quote(location)
    url = f"https://wttr.in/{location}?format=3"
    try:
        with urllib.request.urlopen(url) as response:
            return response.read().decode('utf-8').strip()
    except Exception as e:
        return f"Error fetching weather: {e}"

def github_trending_scraper():
    url = "https://github.com/trending"
    try:
        with urllib.request.urlopen(url) as response:
            html = response.read().decode('utf-8')
            # very naive scraping
            return "Trending repos fetched. (Full parsing not implemented in simple version)"
    except Exception as e:
        return f"Error fetching trending: {e}"

def rss_parser(feed_url):
    try:
        req = urllib.request.Request(feed_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as response:
            xml_data = response.read()
            root = ET.fromstring(xml_data)
            items = []
            for item in root.findall('.//item')[:5]:
                title = item.findtext('title')
                link = item.findtext('link')
                items.append(f"{title}: {link}")
            return "\n".join(items) if items else "No items found."
    except Exception as e:
        return f"Error parsing RSS: {e}"

def register(kernel):
    kernel.tools.add_tool("weather", weather_fetcher)
    kernel.tools.add_tool("github_trending", github_trending_scraper)
    kernel.tools.add_tool("rss_parse", rss_parser)
