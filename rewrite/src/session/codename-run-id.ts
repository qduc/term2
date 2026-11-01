/**
 * Native subagent handles use the source codename vocabulary rather than UUIDs:
 * models can reconstruct adjective-noun-number handles without mistyping hex.
 * Copied from source/services/subagents/codename-run-id.ts as a pure Session leaf
 * to keep the dependency one-way. The Session still owns identity/collisions.
 */
const ADJECTIVES = `
amber ample airy ardent ashen auric azure bold brave breezy bright brisk bronze calm candid cardinal
cerean cheery cirrose clear cobalt copper coral crisp curious daring dazzling deep deft diligent dusky
eager ebon elate ember empty enblithe ernest ethic fair fancy fervid festive flaxen fleet fluid
forthright frank fresh gentle glad golden graceful granite grateful green hardy hasty hazel hearty hewn
honest humble idle indigo ivory jade jolly joyous keen kind kindly kempt lacy lavender leafy lesser lilac
lively lucid lunar lustrous magenta mellow merry mild mint modest mossy muted narrow native natty
nestling new noble noisy novice numinous oblique ochre olive opal open ordinal ornate pale pastel patient
peachy pearly pelagic pensive phanic placid plain plume polite prime primrose punctual pure quiet quill
quintic radiant rapid rare ready regal reluctant resolute restive rightful ripe robust rose rough ruddy
rugged rustic safe sage sallow sandy scarlet searer serene settled severe shady sharp sheen sievert
silken silvern simple sincere sleek snug sober soft solid soothing sound sparoid steady steel stern stoic
stout sturdy sunny sure svelte swart swift tame tan tawny tepid terse thistle tidy timely tip titanic
topaz trim true tundra umber upbeat upright urbane valiant vast verdant vermilion vibrant violet vivid
wary weal wee western wilde willing windy wise witty wonted xeric yellow zealous zesty
`
  .trim()
  .split(/\s+/);

const NOUNS = `
anteater apollo apple apricot arrow ash aspen aurora avocet axiom badger balsa bamboo barley basil beech
beet bell berry birch bison bluebell bobcat bramble bream breeze briar brook buffalo bunting buttercup
cabin cactus camel campion canyon cardinal carnation cascade cashew cedar cherry chestnut chickadee
chiffchaff chive cinder cinnamon citron civet clarion cliff clover cobalt comet condor conifer copper
coral cormorant cosmos cougar cove crab cranberry crane cress crocus crow currant daffodil dahlia daisy
dandelion darter delta dill dingo dolphin dove duck eagle echinus edelweiss egret elder elm emu ermine
evening falcon fawn fennel fern feverfew finch fir firefly fjord flax flicker flora flounder forgetmenot
forsythia fox freesia gannet gardenia garlic gentian geranium glade gladiolus globe goat goose gorm gourd
grape grouse gull halcyon hare harrier hawthorn hazel heather heaven hedge hellebore hemlock henna heron
hibiscus hill holly honey horizon hornbeam hyacinth hydra ibex iris ivy jacamar jackal jasmine junco
juniper kale kestrel kingfisher kite kiwi koala kohl lagoon lamb lavender lark laurel lava leek legume
lemur lentil lettuce lily linden lion lobster locust loft loon lotus lupine lyrebird mango mantis maple
marigold marjoram marsh meadow merlin mica mineral minnow mint mistletoe mocking mollusk monsoon moose
moraine morning moth muffin mulberry myrtle narcissus nebula nettle newt nightingale nimbus nougat
nuthatch oak oat ocean ochre okra olive onion opal orchard orchid oriole oryx otter owl oxlip panda
panther papaya parsley parrot partridge passage pasture pea peach peafowl peanut pear peat pelican
penguin pennon pepper perch petrel phalarope pheasant pickle pigeon pine pistachio planet plateau plum
pollard pomegranate pond poplar poppy porpoise prairie primrose puffin pumpkin quail quartz quince rabbit
raccoon radish raisin rampion rapeseed raven redstart reed reindeer reverie rhubarb ridge river robin
rock rocket rook rose rosemary rowan runner rye safflower saffron sage salamander salmon sapphire savanna
saxifrage scarab scoter seal seagull sequoia shamrock shark sheldrake shrew shrub silver skink skua
skylark slosh snail snipe snowdrop sodium sorrel sparrow spawn spinach spruce squash starling stilton
stoat stone stork stream sumac sunfish sunflower swallow swan sycamore tamarind tanager tarn tarragon
teal thistle thorn thrush thuja tiger toad tomato topaz tor tortoise toucan towhee trefoil trillium trot
trout tulip turmeric turtledove twee umbel underwing ungulate urchin urial valley vanilla varmint veldon
verbena verge vervain vetch violet viper volk walnut warbler wasp watercress weasel wheat wheatear
whimbrel whinchat whitethroat wigeon willow windflower wolf wombat worm wren yarrow yew zinnia zucchini
`
  .trim()
  .split(/\s+/);

/** Generate the same two-word, 10–999 handle format as the source runtime. */
export function createCodenameRunId(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const number = 10 + Math.floor(Math.random() * 990);
  return `${adjective}-${noun}-${number}`;
}
