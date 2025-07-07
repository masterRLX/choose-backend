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
// 404 등으로 실패한 objectID를 기억하여 다시 요청하지 않도록 하는 Set (새로운 기능)
const failedObjectIDs = new Set(); 

// --- Rate Limit 회피 및 안정성 강화를 위한 상수 ---
const API_REQUEST_DELAY_MS = 600; // API 요청 간 최소 딜레이 (0.6초로 약간 증가)
const MAX_SEARCH_RETRIES = 3;     // 검색 실패 시 최대 재시도 횟수
const MAX_DETAIL_RETRIES = 5;     // 상세 정보 실패 시 최대 재시도 횟수
const RETRY_DELAY_MULTIPLIER = 1000; // 재시도 딜레이 증가량 (1초 * 시도 횟수)


const shuffleArray = (array) => { for (let i = array.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [array[i], array[j]] = [array[j], array[i]]; } return array; };

// 서버도 emojiPaintingMap 정보가 필요하므로 여기에 직접 정의합니다.
const emojiPaintingMap = {
    '😌': { keywordGroups: [['portraits', 'landscapes', 'still life', 'serene']], title: '모나리자 - 레오나르도 다빈치' },
    '🤩': { keywordGroups: [['mythological', 'triumph', 'angels', 'cathedral', 'gold']], title: '아담의 창조 - 미켈란젤로' },
    '😂': { keywordGroups: [['celebration', 'dance', 'children', 'festival', 'playful']], title: '진주 귀고리를 한 소녀 - 요하네스 베르메르' },
    '😊': { keywordGroups: [['portraits', 'smile', 'mother', 'child', 'flowers']], title: '자화상 - 빈센트 반 고흐' },
    '😎': { keywordGroups: [['portraits', 'fashion', 'elegant', 'cityscape', 'modern art']], title: '그랑드 자트 섬의 일요일 오후 - 조르주 쇠라' },
    '😁': { keywordGroups: [['music', 'dance', 'party', 'laughing', 'vibrant']], title: '물랭 드 라 갈레트의 무도회 - 피에르 오귀스트 르누아르' },
    '🥰': { keywordGroups: [['love', 'couple', 'embrace', 'venus', 'mother and child']], title: '키스 - 구스타프 클림트' },
    '🥳': { keywordGroups: [['celebration', 'party', 'triumph', 'wedding', 'festival']], title: '라스 메니나스 - 디에고 벨라스케스' },
    '😴': { keywordGroups: [['night', 'landscapes', 'moon', 'dream', 'stillness']], title: '별이 빛나는 밤 - 빈센트 반 고흐' },
    '🤯': { keywordGroups: [['abstract art', 'surrealism', 'cubism', 'geometry']], title: '절규 - 에드바르 뭉크' },
    '😡': { keywordGroups: ['serene landscapes', 'still life with flowers', 'madonna and child', 'peace'], title: '1808년 5월 3일 - 프란시스코 고야' },
    '🥶': { keywordGroups: ['warmth', 'comfort', 'light', 'fire', 'sun', 'summer'], title: '안개 바다 위의 방랑자 - 카스파르 다비트 프리드리히' },
    '🥺': { keywordGroups: ['hope', 'light', 'angels', 'saints', 'charity', 'sunrise'], title: '비너스의 탄생 - 산드로 보티첼리' },
    '🤔': { keywordGroups: ['sculpture', 'philosophy', 'manuscripts', 'maps', 'self-portraits'], title: '생각하는 사람 - 오귀스트 로댕' },
    '🤫': { keywordGroups: ['interiors', 'letters', 'window', 'symbols', 'allegory', 'secret'], title: '아메리칸 고딕 - 그랜트 우드' },
    '😭': { keywordGroups: ['hope', 'light', 'landscapes', 'sunrise', 'solace', 'healing'], title: '최후의 만찬 - 레오나르도 다빈치' }
};

const fetchPaintingsInBackground = async (emoji) => {
    const emojiCache = cache.get(emoji);
    if (!emojiCache || emojiCache.isFetching) return;
    emojiCache.isFetching = true;
    cache.set(emoji, emojiCache);

    try {
        let newFoundPaintings = [];
        let currentIndex = emojiCache.processedIndex;
        
        const targetFetchCount = BATCH_SIZE * 5; 
        
        while (newFoundPaintings.length < targetFetchCount && currentIndex < emojiCache.objectIDs.length) {
            const objectID = emojiCache.objectIDs[currentIndex++];
            // 이미 실패한 ID는 건너뜁니다.
            if (!objectID || failedObjectIDs.has(objectID)) { 
                // console.log(`Skipping failed or invalid objectID: ${objectID}`); // 디버깅용
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
                        // 이미지가 없는 경우도 실패로 간주하고 failedObjectIDs에 추가
                        console.warn(`[BG Detail Skip] Object ID ${objectID}: No primary image.`);
                        failedObjectIDs.add(objectID);
                        break; // 이미지가 없으면 재시도해도 소용없으니 탈출
                    }
                } catch (e) {
                    const status = e.response ? e.response.status : 'N/A';
                    console.warn(`[BG Detail Error] Object ID ${objectID} (Attempt ${i + 1}/${MAX_DETAIL_RETRIES}, Status: ${status}): ${e.message}`);
                    if (status === 403 || status === 404 || i === MAX_DETAIL_RETRIES - 1) {
                         // 403, 404는 재시도 무의미, 또는 마지막 시도 실패 시
                         console.error(`[BG Detail Error] Aborting retries for ${objectID} due to status ${status} or max retries.`);
                         failedObjectIDs.add(objectID); // 실패한 ID 기록
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
            return res.status(404).json({ error: 'All available paintings for this emoji have been shown.' });
        } else {
            return res.status(202).json({ message: 'Fetching more paintings in the background. Please try again shortly.' });
        }
    }

    try {
        const paintingData = emojiPaintingMap[emoji];
        if (!paintingData) {
            console.error(`Invalid emoji: ${emoji}`);
            return res.status(400).json({ error: 'Invalid emoji provided.' });
        }

        let allObjectIDs = [];
        const searchKeywordStrings = paintingData.keywordGroups.map(group => group.join(','));
        
        for (const keywordString of searchKeywordStrings) {
            let searchUrl = `${MET_API_BASE_URL}/search?q=${encodeURIComponent(keywordString)}&hasImages=true`;

            for (let i = 0; i < MAX_SEARCH_RETRIES; i++) {
                try {
                    await new Promise(resolve => setTimeout(resolve, API_REQUEST_DELAY_MS));
                    const searchResponse = await axios.get(searchUrl, { timeout: 15000 });
                    if (searchResponse.data && Array.isArray(searchResponse.data.objectIDs)) {
                        allObjectIDs.push(...searchResponse.data.objectIDs);
                        break;
                    }
                } catch (searchError) {
                    const status = searchError.response ? searchError.response.status : 'N/A';
                    console.warn(`[Search Error] Keyword group [${keywordString}] (Attempt ${i + 1}/${MAX_SEARCH_RETRIES}, Status: ${status}): ${searchError.message}`);
                    if (status === 403 || i === MAX_SEARCH_RETRIES - 1) { // 403은 재시도 무의미, 마지막 시도 실패 시
                        console.error(`[Search Error] Aborting retries for search due to status ${status} or max retries.`);
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MULTIPLIER * (i + 1)));
                }
            }
        }

        if (allObjectIDs.length === 0) {
            return res.status(404).json({ error: `No objects found for the emoji keywords: ${emoji}` });
        }

        // 중복 제거 및 failedObjectIDs에 있는 ID 제거 후 셔플
        const uniqueShuffledObjectIDs = shuffleArray([...new Set(allObjectIDs)].filter(id => !failedObjectIDs.has(id)));

        const newCacheEntry = { paintings: [], objectIDs: uniqueShuffledObjectIDs, processedIndex: 0, isFetching: false };
        cache.set(emoji, newCacheEntry);

        await fetchPaintingsInBackground(emoji);

        const finalCache = cache.get(emoji);
        if (finalCache.paintings.length > 0) {
            const batchToSend = finalCache.paintings.splice(0, BATCH_SIZE);
            res.json(batchToSend);
            fetchPaintingsInBackground(emoji);
        } else {
            res.status(404).json({ error: 'Could not find any valid paintings from the initial search.' });
        }
    } catch (error) {
        console.error(`[FATAL SERVER ERROR] For ${emoji}:`, error.message);
        return res.status(500).json({ error: 'Failed to process request for painting data.' });
    }
});

app.listen(PORT, () => {
    console.log(`최종 완성 서버가 http://localhost:${PORT} 포트에서 실행 중입니다.`);
});