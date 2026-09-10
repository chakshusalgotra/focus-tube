'use strict';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_RE = /^(?:PL|UU|FL|OL)[A-Za-z0-9_-]{5,}$/;
const SEARCH_TYPES = new Set(['all', 'video', 'playlist', 'course']);

function searchError(status, message) {
  return Object.assign(new Error(message), { status });
}

function createSearchRequest(query, type = 'all') {
  if (typeof query !== 'string' || !query.trim() || query.trim().length > 200) {
    throw searchError(400, 'Enter a search term between 1 and 200 characters.');
  }
  if (!SEARCH_TYPES.has(type)) {
    throw searchError(400, 'Choose All, Videos, Playlists, or Courses.');
  }
  query = query.trim().replace(/\s+/g, ' ');
  const searchQuery = type === 'course' && !/\bcourse\b/i.test(query) ? `${query} full course` : query;
  const url = new URL('https://www.youtube.com/results');
  url.searchParams.set('search_query', searchQuery);
  url.searchParams.set('hl', 'en');
  if (type === 'video') url.searchParams.set('sp', 'EgIQAQ==');
  if (type === 'playlist') url.searchParams.set('sp', 'EgIQAw==');
  return { query, type, youtubeUrl: url.href };
}

function textOf(value) {
  if (typeof value === 'string') return value;
  return value?.content || value?.simpleText || value?.runs?.map(run => run.text || '').join('') || '';
}

function valuesOf(node, key, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Object.hasOwn(node, key)) out.push(node[key]);
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') valuesOf(value, key, out);
  }
  return out;
}

function thumbnailOf(node, videoId) {
  if (VIDEO_ID_RE.test(videoId || '')) return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  for (const candidate of valuesOf(node, 'url')) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'https:' || url.hostname !== 'i.ytimg.com') continue;
      const match = url.pathname.match(/^\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})\//);
      if (match) return `https://i.ytimg.com/vi/${match[1]}/mqdefault.jpg`;
    } catch {}
  }
  return '';
}

function countOf(value) {
  const match = textOf(value).match(/^([\d,]+)(?:\s+(?:videos?|lessons?))?$/i);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function parseRenderer(item) {
  const video = item.videoRenderer;
  if (video) {
    return {
      id: video.videoId,
      type: 'video',
      isCourse: false,
      title: textOf(video.title),
      author: textOf(video.ownerText || video.longBylineText || video.shortBylineText),
      description: video.detailedMetadataSnippets?.map(snippet => textOf(snippet.snippetText)).join(' ') || textOf(video.descriptionSnippet),
      thumbnail: thumbnailOf(video.thumbnail, video.videoId),
      duration: textOf(video.lengthText),
      videoCount: 1,
      metadata: [textOf(video.viewCountText), textOf(video.publishedTimeText)].filter(Boolean).join(' / '),
    };
  }
  const playlist = item.playlistRenderer;
  if (playlist) {
    return {
      id: playlist.playlistId,
      type: 'playlist',
      isCourse: Boolean(playlist.isCourse),
      title: textOf(playlist.title),
      author: textOf(playlist.longBylineText || playlist.shortBylineText),
      description: textOf(playlist.descriptionText) || (playlist.videos || []).map(video => textOf(video.childVideoRenderer?.title)).filter(Boolean).join(' / '),
      thumbnail: thumbnailOf(playlist.thumbnails || playlist.thumbnailRenderer),
      duration: '',
      videoCount: countOf(playlist.videoCount || playlist.videoCountText),
      metadata: '',
    };
  }
  const lockup = item.lockupViewModel;
  if (!lockup) return null;
  const type = lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' ? 'video'
    : ['LOCKUP_CONTENT_TYPE_PLAYLIST', 'LOCKUP_CONTENT_TYPE_COURSE'].includes(lockup.contentType) ? 'playlist' : null;
  if (!type) return null;
  const metadata = lockup.metadata?.lockupMetadataViewModel;
  const rows = metadata?.metadata?.contentMetadataViewModel?.metadataRows || [];
  const headerParts = rows[0]?.metadataParts || [];
  const badges = valuesOf(lockup.contentImage, 'thumbnailBadgeViewModel');
  const previews = rows.slice(1).flatMap(row => row.metadataParts || [])
    .filter(part => valuesOf(part.text, 'watchEndpoint').length)
    .map(part => textOf(part.text));
  const endpoint = lockup.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint;
  const id = lockup.contentId || (type === 'video' ? endpoint?.videoId : endpoint?.playlistId);
  return {
    id,
    type,
    isCourse: lockup.contentType === 'LOCKUP_CONTENT_TYPE_COURSE' || headerParts.some(part => textOf(part.text) === 'Course') || valuesOf(lockup.contentImage, 'imageName').includes('COURSE'),
    title: textOf(metadata?.title),
    author: textOf(headerParts[0]?.text),
    description: textOf(lockup.description) || previews.join(' / '),
    thumbnail: thumbnailOf(lockup.contentImage, type === 'video' ? id : null),
    duration: type === 'video' ? badges.map(badge => textOf(badge.text)).find(text => /^\d+(?::\d{2})+$/.test(text)) || '' : '',
    videoCount: type === 'video' ? 1 : badges.map(badge => countOf(badge.text)).find(count => count !== null) ?? null,
    metadata: '',
  };
}

function parseSearchResults(data, type = 'all') {
  const primary = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents;
  const sections = primary?.sectionListRenderer?.contents;
  if (!Array.isArray(sections)) {
    throw searchError(502, 'YouTube search is unavailable right now. Try again or open the search on YouTube.');
  }
  const results = [];
  const seen = new Set();
  for (const section of sections) {
    for (const item of section.itemSectionRenderer?.contents || []) {
      const result = parseRenderer(item);
      if (!result || !result.title) continue;
      if (!(result.type === 'video' ? VIDEO_ID_RE : PLAYLIST_ID_RE).test(result.id || '')) continue;
      if ((type === 'video' || type === 'playlist') && result.type !== type) continue;
      const key = `${result.type}:${result.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.url = result.type === 'video'
        ? `https://www.youtube.com/watch?v=${result.id}`
        : `https://www.youtube.com/playlist?list=${result.id}`;
      result.title = result.title.slice(0, 500);
      result.author = result.author.slice(0, 200);
      result.description = result.description.slice(0, 1200);
      results.push(result);
      if (results.length === 24) return results;
    }
  }
  return results;
}

module.exports = { createSearchRequest, parseSearchResults };