import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { emojiPaintingMap } from './data.js';

const app = express();
const PORT = 8080;
app.use(cors());
app.use(express.json());

const MET_API_BASE_URL = 'https://collectionapi.metmuseum.org/public/collection/v1';
const BATCH_SIZE = 5;
const cache = new Map();

const shuffleArray = (array) => { for (let i = array.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [array[i], array[j]] = [array[j], array[i]]; } return array; };

const fetchPaintingsInBackground = async (emoji) => {
    const emojiCache = cache.get(emoji);
    if (!emojiCache || emojiCache.isFetching) return;
    emojiCache.isFetching = true;
    cache.set(emoji, emojiCache);
    try {
        let newFoundPaintings = [];
        let currentIndex = emojiCache.processedIndex;
        while (newFoundPaintings.length < BATCH_SIZE && currentIndex < emojiCache.objectIDs.length) {
            const objectID = emojiCache.objectIDs[currentIndex++];
            try {
                const detailUrl = `${MET_API_BASE_URL}/objects/${objectID}`;
                const detailResponse = await axios.get(detailUrl, { timeout: 7000 });
                if (detailResponse.data && detailResponse.data.primaryImageSmall) {
                    newFoundPaintings.push({ 
                        img_lq: detailResponse.data.primaryImageSmall,
                        img_hq: detailResponse.data.primaryImage || detailResponse.data.primaryImageSmall,
                        title: detailResponse.data.title || '제목 없음', 
                        artist: detailResponse.data.artistDisplayName || '작가 미상', 
                        objectURL: detailResponse.data.objectURL || '#' 
                    });
                }
            } catch (e) { /* 개별 실패 무시 */ }
        }
        if (newFoundPaintings.length > 0) {
            emojiCache.paintings.push(...newFoundPaintings);
        }
        emojiCache.processedIndex = currentIndex;
    } catch (error) { console.error(`[BG Fetch Error] For ${emoji}:`, error.message); } 
    finally { emojiCache.isFetching = false; cache.set(emoji, emojiCache); }
};

app.get('/api/painting', async (req, res) => {
    const { emoji } = req.query;
    if (!emoji) return res.status(400).json({ error: 'Emoji is required' });

    if (cache.has(emoji)) {
        const emojiCache = cache.get(emoji);
        if (emojiCache.paintings.length > 0) {
            const batchToSend = emojiCache.paintings.splice(0, BATCH_SIZE);
            res.json(batchToSend);
            fetchPaintingsInBackground(emoji);
            return;
        }
        if (!emojiCache.isFetching) {
            await fetchPaintingsInBackground(emoji);
            const updatedCache = cache.get(emoji);
            if (updatedCache.paintings.length > 0) {
                const batchToSend = updatedCache.paintings.splice(0, BATCH_SIZE);
                res.json(batchToSend);
                fetchPaintingsInBackground(emoji);
                return;
            }
        }
        if (emojiCache.processedIndex >= emojiCache.objectIDs.length && emojiCache.paintings.length === 0) {
            return res.status(404).json({ error: 'All paintings for this emoji have been shown.' });
        } else {
            return res.status(202).json({ message: 'Paintings are being fetched...' });
        }
    }

    try {
        const paintingData = emojiPaintingMap[emoji];
        if (!paintingData) throw new Error('Invalid emoji');
        
        const firstKeywords = paintingData.keywordGroups[0];
        const searchUrl = `${MET_API_BASE_URL}/search?q=${encodeURIComponent(firstKeywords)}&hasImages=true`;
        const searchResponse = await axios.get(searchUrl, { timeout: 15000 });

        if (!searchResponse.data || !searchResponse.data.objectIDs) {
            return res.status(404).json({ error: `No objects found for the initial keyword: ${firstKeywords}` });
        }

        const initialObjectIDs = shuffleArray(searchResponse.data.objectIDs);
        const newCacheEntry = { paintings: [], objectIDs: initialObjectIDs, processedIndex: 0, isFetching: false };
        cache.set(emoji, newCacheEntry);
        
        await fetchPaintingsInBackground(emoji);

        const addMoreKeywordsInBackground = async () => { /* ... 이전과 동일 ... */ };
        addMoreKeywordsInBackground();

        const finalCache = cache.get(emoji);
        if (finalCache.paintings.length > 0) {
            const batchToSend = finalCache.paintings.splice(0, BATCH_SIZE);
            res.json(batchToSend);
            fetchPaintingsInBackground(emoji);
        } else {
            res.status(404).json({ error: 'Could not find any valid paintings from the first search.' });
        }
    } catch (error) {
        console.error(`[FATAL ERROR] For ${emoji}:`, error.message);
        return res.status(500).json({ error: 'Failed to fetch data from the Met API.' });
    }
});

app.listen(PORT, () => {
    console.log(`최종 완성 서버가 http://localhost:${PORT} 포트에서 실행 중입니다.`);
});