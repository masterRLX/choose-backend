import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
const PORT = 8080;
app.use(cors());
app.use(express.json());

const MET_API_BASE_URL = 'https://collectionapi.metmuseum.org/public/collection/v1';
const BATCH_SIZE = 5;
const cache = new Map();
const failedObjectIDs = new Set(); 

// --- Rate Limit 회피 및 안정성 강화를 위한 상수 (보수적인 설정 유지) ---
const API_REQUEST_DELAY_MS = 1500; // API 요청 간 최소 딜레이 (1.5초)
const MAX_SEARCH_RETRIES = 2;     // 검색 실패 시 최대 재시도 횟수 (2회)
const MAX_DETAIL_RETRIES = 3;     // 상세 정보 실패 시 최대 재시도 횟수 (3회)
const RETRY_DELAY_MULTIPLIER = 2000; // 재시도 딜레이 증가량 (2초 * 시도 횟수)


const shuffleArray = (array) => { for (let i = array.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [array[i], array[j]] = [array[j], array[i]]; } return array; };

// 서버도 emojiPaintingMap 정보가 필요하므로 여기에 직접 정의합니다.
// ✨ 🤩 이모지의 키워드를 다시 한번 대폭 완화했습니다. ✨
const emojiPaintingMap = {
    '😌': { keywordGroups: [['portraits', 'landscapes', 'still life', 'serene']], title: '모나리자 - 레오나르도 다빈치' },
    '🤩': { keywordGroups: [['art', 'painting', 'masterpiece', 'figure', 'scene', 'portrait', 'collection', 'museum', 'divine', 'beauty', 'grand']], title: '아담의 창조 - 미켈란젤로' }, // ✨ 키워드 대폭 완화 ✨
    '😂': { keywordGroups: [['celebration', 'dance', 'children', 'festival', 'playful']], title: '진주 귀고리를 한 소녀 - 요하네스 베르메르' },
    '😊': { keywordGroups: [['art', 'painting', 'masterpiece', 'figure', 'scene', 'portrait', 'collection', 'museum', 'happy', 'human']], title: '자화상 - 빈센트 반 고흐' },
    '😎': { keywordGroups: [['portraits', 'fashion', 'elegant', 'cityscape', 'modern art']], title: '그랑드 자트 섬의 일요일 오후 - 조르주 쇠라' },
    '😁': { keywordGroups: [['music', 'dance', 'party', 'laughing', 'vibrant']], title: '물랭 드 라 갈레트의 무도회 - 피에르 오귀스트 르누아르' },
    '🥰': { keywordGroups: [['love', 'couple', 'embrace', 'venus', 'mother and child']], title: '키스 - 구스타프 클림트' },
    '🥳': { keywordGroups: [['joy', 'happiness', 'celebration', 'excitement', 'singing', 'music', 'dance']], title: '라스 메니나스 - 디에고 벨라스케스' },
    '😴': { keywordGroups: [['night', 'landscapes', 'moon', 'dream', 'stillness']], title: '별이 빛나는 밤 - 빈센트 반 고흐' },
    '🤯': { keywordGroups: [['abstract art', 'surrealism', 'cubism', 'geometry']], title: '절규 - 에드바르 뭉크' },
    '😡': { keywordGroups: ['serene landscapes', 'still life with flowers', 'madonna and child', 'peace'], title: '1808년 5월 3일 - 프란시스코 고야' },
    '🥶': { keywordGroups: [['art', 'painting', 'masterpiece', 'figure', 'scene', 'portrait', 'collection', 'museum', 'cold', 'winter']], title: '안개 바다 위의 방랑자 - 카스파르 다비트 프리드리히' },
    '🥺': { keywordGroups: ['hope', 'light', 'angels', 'saints', 'charity', 'sunrise'], title: '비너스의 탄생 - 산드로 보티첼리' },
    '🤔': { keywordGroups: ['sculpture', 'philosophy', 'manuscripts', 'maps', 'self-portraits'], title: '생각하는 사람 - 오귀스트 로댕' },
    '🤫': { keywordGroups: ['interiors', 'letters', 'window', 'symbols', 'allegory', 'secret'], title: '아메리칸 고딕 - 그랜트 우드' },
    '😭': { keywordGroups: ['hope', 'light', 'landscapes', 'sunrise', 'solace', 'healing'], title: '최후의 만찬 - 레오나르도 다빈치' }
};

// 모든 emojiPaintingMap의 keywordGroups를 2차원 배열로 강제 통일 (방어 로직)
for (const emojiKey in emojiPaintingMap) {
    if (emojiPaintingMap.hasOwnProperty(emojiKey)) {
        const entry = emojiPaintingMap[emojiKey];
        if (entry.keywordGroups && !Array.isArray(entry.keywordGroups[0])) {
            entry.keywordGroups = [entry.keywordGroups];
            console.warn(`[Data Fix] ${emojiKey} keywordGroups was 1D, converted to 2D.`);
        }
    }
}


const fetchPaintingsInBackground = async (emoji) => {
    const emojiCache = cache.get(emoji);
    if (!emojiCache || emojiCache.isFetching) return;
    emojiCache.isFetching = true;
    cache.set(emoji, emojiCache);

    try {
        let newFoundPaintings = [];
        let currentIndex = emojiCache.processedIndex;
        
        const targetFetchCount = BATCH_SIZE; 
        
        while (newFoundPaintings.length < targetFetchCount && currentIndex < emojiCache.objectIDs.length) {
            const objectID = emojiCache.objectIDs[currentIndex++];
            if (!objectID || failedObjectIDs.has(objectID)) { 
                continue; 
            }

            for (let i = 0; i < MAX_DETAIL_RETRIES; i++) {
                try {
                    await new Promise(resolve => setTimeout(resolve, API_REQUEST_DELAY_MS));
                    const detailUrl = `${MET_API_BASE_URL}/objects/${objectID}`;
                    const detailResponse = await axios.get(detailUrl, { timeout: 7000 });

                    if (detailResponse.data && (detailResponse.data.primaryImage || detailResponse.data.primaryImageSmall)) {
                        newFoundPaintings.push({
                            img_lq: detailResponse.data.primaryImageSmall,
                            img_hq: detailResponse.data.primaryImage || detailResponse.data.primaryImageSmall,
                            title: detailResponse.data.title || '제목 없음',
                            artist: detailResponse.data.artistDisplayName || '작가 미상',
                            objectURL: detailResponse.data.objectURL || '#'
                        });
                        break;
                    } else {
                        console.warn(`[BG Detail Skip] Object ID ${objectID}: No primary image.`);
                        failedObjectIDs.add(objectID);
                        break;
                    }
                } catch (e) {
                    const status = e.response ? e.response.status : 'N/A';
                    console.warn(`[BG Detail Error] Object ID ${objectID} (Attempt ${i + 1}/${MAX_DETAIL_RETRIES}, Status: ${status}): ${e.message}`);
                    if (status === 403 || status === 404 || i === MAX_DETAIL_RETRIES - 1) {
                         console.error(`[BG Detail Error] Aborting retries for ${objectID} due to status ${status} or max retries.`);
                         failedObjectIDs.add(objectID);
                         break;
                    }
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MULTIPLIER * (i + 1)));
                }
            }
        }
        if (newFoundPaintings.length > 0) {
            emojiCache.paintings.push(...shuffleArray(newFoundPaintings));
        }
        emojiCache.processedIndex = currentIndex;
    } catch (error) {
        console.error(`[BG Fetch Error] For ${emoji}:`, error.message);
    }
    finally {
        emojiCache.isFetching = false;
        cache.set(emoji, emojiCache);
    }
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
            console.log(`[Cache Miss] Starting background fetch for ${emoji}`);
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
            return res.status(404).json({ error: 'All available objects for this emoji have been shown or could not be found.' }); 
        } else {
            return res.status(202).json({ message: 'Fetching more objects in the background. Please try again shortly.' }); 
        }
    }

    try {
        const paintingData = emojiPaintingMap[emoji];
        if (!paintingData || !paintingData.keywordGroups || !Array.isArray(paintingData.keywordGroups)) {
            console.error(`Invalid or malformed emoji data for: ${emoji}`);
            return res.status(400).json({ error: 'Invalid or malformed emoji data provided.' });
        }

        let allObjectIDs = [];
        const primaryKeywordGroups = paintingData.keywordGroups;

        for (const keywordsArray of primaryKeywordGroups) {
            if (!Array.isArray(keywordsArray)) {
                console.warn(`[Data Warning] Expected keywordsArray to be an array for emoji ${emoji}, but received:`, keywordsArray);
                continue;
            }

            const keywordString = keywordsArray.join(','); 
            let searchUrl = `${MET_API_BASE_URL}/search?q=${encodeURIComponent(keywordString)}&hasImages=true`; 

            for (let i = 0; i < MAX_SEARCH_RETRIES; i++) {
                try {
                    await new Promise(resolve => setTimeout(resolve, API_REQUEST_DELAY_MS));
                    const searchResponse = await axios.get(searchUrl, { timeout: 15000 });
                    if (searchResponse.data && Array.isArray(searchResponse.data.objectIDs) && searchResponse.data.objectIDs.length > 0) {
                        allObjectIDs.push(...searchResponse.data.objectIDs);
                        console.log(`[Search Success] Found ${searchResponse.data.objectIDs.length} IDs for ${keywordString}.`);
                        break; 
                    } else {
                        console.warn(`[Search Empty] Keyword group [${keywordString}] found no objectIDs.`);
                    }
                } catch (searchError) {
                    const status = searchError.response ? searchError.response.status : 'N/A';
                    console.warn(`[Search Error] Keyword group [${keywordString}] (Attempt ${i + 1}/${MAX_SEARCH_RETRIES}, Status: ${status}): ${searchError.message}`);
                    if (status === 403 || i === MAX_SEARCH_RETRIES - 1) { 
                        console.error(`[Search Error] 403 Forbidden. Aborting retries for this keyword group.`);
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MULTIPLIER * (i + 1)));
                }
            }
        }
        
        if (allObjectIDs.length === 0) {
            return res.status(404).json({ error: `No objects found for the emoji keywords after all attempts: ${emoji}` });
        }

        const uniqueShuffledObjectIDs = shuffleArray([...new Set(allObjectIDs)].filter(id => !failedObjectIDs.has(id)));

        if (uniqueShuffledObjectIDs.length === 0) {
            return res.status(404).json({ error: `No usable images found for the emoji: ${emoji} after filtering.` });
        }

        const newCacheEntry = { paintings: [], objectIDs: uniqueShuffledObjectIDs, processedIndex: 0, isFetching: false };
        cache.set(emoji, newCacheEntry);

        await fetchPaintingsInBackground(emoji);

        const finalCache = cache.get(emoji);
        if (finalCache.paintings.length > 0) {
            const batchToSend = finalCache.paintings.splice(0, BATCH_SIZE);
            res.json(batchToSend);
            fetchPaintingsInBackground(emoji); 
        } else {
            res.status(202).json({ message: 'Initial batch not ready, fetching in background. Please try again.' });
        }
    } catch (error) {
        console.error(`[FATAL SERVER ERROR] For ${emoji}:`, error.message);
        return res.status(500).json({ error: 'Failed to process request for object data due to unexpected server error.' });
    }
});

app.listen(PORT, () => {
    console.log(`최종 완성 서버가 http://localhost:${PORT} 포트에서 실행 중입니다.`);
});