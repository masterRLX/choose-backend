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
// 이모지 키워드 그룹은 2차원 배열로 정의되어 있습니다. (이전 최종 작업 상태로 복원)
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
    '🤯': { keywordGroups: ['abstract art', 'surrealism', 'cubism', 'geometry'], title: '절규 - 에드바르 뭉크' },
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
        
        // 백그라운드에서 가져올 그림 수를 BATCH_SIZE (5개)로 최소화하여 부담 감소
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

                    // primaryImage 또는 primaryImageSmall이 있는 경우만 유효한 작품으로 간주
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
                        failedObjectIDs.add(objectID); // 이미지가 없으면 기록하고 재시도하지 않음
                        break;
                    }
                } catch (e) {
                    const status = e.response ? e.response.status : 'N/A';
                    console.warn(`[BG Detail Error] Object ID ${objectID} (Attempt ${i + 1}/${MAX_DETAIL_RETRIES}, Status: ${status}): ${e.message}`);
                    if (status === 403 || status === 404 || i === MAX_DETAIL_RETRIES - 1) {
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
            // 모든 objectIDs를 처리했고, paintings 배열도 비어있다면
            return res.status(404).json({ error: 'All available objects for this emoji have been shown or could not be found.' }); 
        } else {
            // 그림이 아직 준비 중이거나, 추가 페칭이 필요한 경우 (백그라운드에서 계속 시도 중)
            return res.status(202).json({ message: 'Fetching more objects in the background. Please try again shortly.' }); 
        }
    }

    // 캐시에 없는 새로운 이모지 요청인 경우
    try {
        const paintingData = emojiPaintingMap[emoji];
        if (!paintingData) {
            console.error(`Invalid emoji: ${emoji}`);
            return res.status(400).json({ error: 'Invalid emoji provided.' });
        }

        let allObjectIDs = [];
        const primaryKeywordGroups = paintingData.keywordGroups;

        // 모든 키워드 그룹에 대해 검색 시도 (medium 필터 없이 더 느슨하게)
        for (const keywordsArray of primaryKeywordGroups) {
            const keywordString = keywordsArray.join(','); // 올바른 join 호출
            // ✨ medium 필터링을 제거하여 모든 유형의 작품을 검색하도록 합니다. ✨
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
        
        // Fallback medium 검색 로직 제거 (더 느슨한 기본 검색으로 대체)
        // if (allObjectIDs.length < BATCH_SIZE * 2 && searchAttempted) { ... }

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