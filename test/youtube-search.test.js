'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSearchRequest, parseSearchResults } = require('../youtube-search');

const video = {
  videoRenderer: {
    videoId: 'abcdefghijk',
    title: { runs: [{ text: 'Python full course' }] },
    ownerText: { runs: [{ text: 'Example teacher' }] },
    lengthText: { simpleText: '2:15:00' },
    detailedMetadataSnippets: [{ snippetText: { runs: [{ text: 'Variables, loops, and projects.' }] } }],
  },
};
const playlist = {
  playlistRenderer: {
    playlistId: 'PLexample123',
    title: { simpleText: 'Python lessons' },
    shortBylineText: { simpleText: 'Example teacher' },
    videoCount: '12',
    thumbnails: [{ thumbnails: [{ url: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' }] }],
    videos: [{ childVideoRenderer: { videoId: 'nested12345', title: { simpleText: 'Lesson one' } } }],
  },
};
const course = {
  lockupViewModel: {
    contentId: 'PLcourse1234',
    contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST',
    contentImage: {
      collectionThumbnailViewModel: {
        image: { sources: [{ url: 'https://i.ytimg.com/vi/abcdefghijk/hq720.jpg' }] },
        thumbnailBadgeViewModel: { text: '9 lessons', icon: { sources: [{ clientResource: { imageName: 'COURSE' } }] } },
      },
    },
    metadata: {
      lockupMetadataViewModel: {
        title: { content: 'Python language full course' },
        metadata: { contentMetadataViewModel: { metadataRows: [
          { metadataParts: [{ text: { content: 'Course creator' } }, { text: { content: 'Course' } }] },
          { metadataParts: [{ text: { content: 'Variables and data types', commandRuns: [{ onTap: { innertubeCommand: { watchEndpoint: { videoId: 'abcdefghijk' } } } }] } }] },
        ] } },
      },
    },
  },
};

function searchPage(items) {
  return { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: {
    contents: [{ itemSectionRenderer: { contents: items } }],
  } } } } };
}

test('builds encoded, type-filtered YouTube searches', () => {
  const request = createSearchRequest('  C++ & data  ', 'video');
  const url = new URL(request.youtubeUrl);
  assert.equal(request.query, 'C++ & data');
  assert.equal(url.origin, 'https://www.youtube.com');
  assert.equal(url.searchParams.get('search_query'), 'C++ & data');
  assert.equal(url.searchParams.get('sp'), 'EgIQAQ==');
  assert.equal(new URL(createSearchRequest('python', 'playlist').youtubeUrl).searchParams.get('sp'), 'EgIQAw==');
  assert.equal(new URL(createSearchRequest('python', 'course').youtubeUrl).searchParams.get('search_query'), 'python full course');
  assert.equal(new URL(createSearchRequest('Python course', 'course').youtubeUrl).searchParams.get('search_query'), 'Python course');
});

test('rejects invalid queries and filters', () => {
  for (const query of ['', '   ', 'a'.repeat(201), ['python'], undefined]) {
    assert.throws(() => createSearchRequest(query), { status: 400 });
  }
  assert.throws(() => createSearchRequest('python', 'channel'), { status: 400 });
});

test('normalizes classic video and playlist metadata without collecting preview children', () => {
  const results = parseSearchResults(searchPage([video, playlist]));
  assert.equal(results.length, 2);
  assert.equal(results[0].description, 'Variables, loops, and projects.');
  assert.equal(results[0].duration, '2:15:00');
  assert.equal(results[0].url, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(results[1].videoCount, 12);
  assert.equal(results[1].thumbnail, 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg');
  assert.equal(results[1].description, 'Lesson one');
});

test('recognizes modern course playlists and retains their real import type', () => {
  const [result] = parseSearchResults(searchPage([course]));
  assert.equal(result.type, 'playlist');
  assert.equal(result.isCourse, true);
  assert.equal(result.author, 'Course creator');
  assert.equal(result.videoCount, 9);
  assert.equal(result.description, 'Variables and data types');
  assert.equal(result.url, 'https://www.youtube.com/playlist?list=PLcourse1234');
});

test('normalizes modern videos and imports the video rather than its linked playlist', () => {
  const modern = structuredClone(course);
  modern.lockupViewModel.contentId = 'modern12345';
  modern.lockupViewModel.contentType = 'LOCKUP_CONTENT_TYPE_VIDEO';
  modern.lockupViewModel.contentImage = { thumbnailBadgeViewModel: { text: '2:05:10' } };
  modern.lockupViewModel.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows = [
    { metadataParts: [{ text: { content: 'Video creator' } }] },
  ];
  modern.lockupViewModel.rendererContext = { commandContext: { onTap: { innertubeCommand: {
    watchEndpoint: { videoId: 'modern12345', playlistId: 'PLcourse1234' },
  } } } };
  const [result] = parseSearchResults(searchPage([modern]), 'video');
  assert.equal(result.duration, '2:05:10');
  assert.equal(result.author, 'Video creator');
  assert.equal(result.videoCount, 1);
  assert.equal(result.isCourse, false);
  assert.equal(result.thumbnail, 'https://i.ytimg.com/vi/modern12345/mqdefault.jpg');
  assert.equal(result.url, 'https://www.youtube.com/watch?v=modern12345');
});

test('reads collection counts and does not invent official course labels from titles', () => {
  const collection = structuredClone(course);
  collection.lockupViewModel.contentImage = {
    image: { sources: [{ url: 'https://i.ytimg.com/vi_webp/abcdefghijk/maxresdefault.webp' }] },
    thumbnailBadgeViewModel: { text: '1,205 videos' },
  };
  collection.lockupViewModel.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows[0].metadataParts.pop();
  const [result] = parseSearchResults(searchPage([collection]), 'playlist');
  assert.equal(result.videoCount, 1205);
  assert.equal(result.isCourse, false);
  assert.equal(result.thumbnail, 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg');
});

test('bounds titles, creators, and descriptions from upstream metadata', () => {
  const oversized = structuredClone(video);
  oversized.videoRenderer.title = { simpleText: 'Title'.repeat(200) };
  oversized.videoRenderer.ownerText = { simpleText: 'Creator'.repeat(100) };
  oversized.videoRenderer.detailedMetadataSnippets = [{ snippetText: { simpleText: 'Description'.repeat(300) } }];
  const [result] = parseSearchResults(searchPage([oversized]));
  assert.equal(result.title.length, 500);
  assert.equal(result.author.length, 200);
  assert.equal(result.description.length, 1200);
});

test('filters by type, deduplicates, and excludes ads, channels, mixes, and invalid IDs', () => {
  const page = searchPage([
    video, playlist, course, video,
    { adSlotRenderer: { videoRenderer: video.videoRenderer } },
    { channelRenderer: { channelId: 'channel123' } },
    { playlistRenderer: { ...playlist.playlistRenderer, playlistId: 'RDexample123' } },
    { videoRenderer: { ...video.videoRenderer, videoId: 'bad&id=other' } },
  ]);
  assert.equal(parseSearchResults(page).length, 3);
  assert.deepEqual(parseSearchResults(page, 'video').map(result => result.type), ['video']);
  assert.deepEqual(parseSearchResults(page, 'playlist').map(result => result.type), ['playlist', 'playlist']);
  assert.equal(parseSearchResults(page, 'course').length, 3);
});

test('distinguishes an empty search from a blocked or unrecognized page', () => {
  assert.deepEqual(parseSearchResults(searchPage([{ messageRenderer: { text: { simpleText: 'No results found' } } }])), []);
  assert.throws(() => parseSearchResults({}), { status: 502 });
});

test('does not forward untrusted thumbnails and bounds results', () => {
  const unsafe = structuredClone(playlist);
  unsafe.playlistRenderer.thumbnails[0].thumbnails[0].url = 'https://evil.example/image.jpg';
  assert.equal(parseSearchResults(searchPage([unsafe]))[0].thumbnail, '');
  const items = Array.from({ length: 40 }, (_, index) => ({
    videoRenderer: { ...video.videoRenderer, videoId: String(index).padStart(11, '0') },
  }));
  assert.equal(parseSearchResults(searchPage(items)).length, 24);
});