/**
 * EmojiPicker — bottom-sheet content for picking an emoji.
 * Categories + search + recents (persisted to AsyncStorage).
 * No new dependency: uses a curated static list of common emojis.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  FlatList,
  Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';

const RECENTS_KEY = '@allo/emoji-recents';
const MAX_RECENTS = 32;

interface EmojiEntry {
  e: string; // the emoji
  k: string; // searchable keywords (space-separated)
}

type Category = {
  id: string;
  icon: string;
  emojis: EmojiEntry[];
};

const cat = (id: string, icon: string, list: [string, string][]): Category => ({
  id,
  icon,
  emojis: list.map(([e, k]) => ({ e, k })),
});

// Curated emoji set (~500 common entries grouped by Unicode category).
const SMILEYS: [string, string][] = [
  ['😀', 'grin smile happy'], ['😃', 'grin smile happy'], ['😄', 'smile happy'],
  ['😁', 'beam grin'], ['😆', 'laugh haha'], ['😅', 'sweat smile'], ['🤣', 'rofl laugh'],
  ['😂', 'joy tears laugh'], ['🙂', 'slight smile'], ['🙃', 'upside down'], ['😉', 'wink'],
  ['😊', 'blush smile'], ['😇', 'innocent halo'], ['🥰', 'love hearts'], ['😍', 'love eyes'],
  ['🤩', 'star struck'], ['😘', 'kiss blow'], ['😗', 'kiss'], ['😚', 'kiss closed'],
  ['😋', 'yum tongue'], ['😛', 'tongue out'], ['😜', 'wink tongue'], ['🤪', 'zany'],
  ['😝', 'tongue closed eyes'], ['🤑', 'money mouth'], ['🤗', 'hug hugging'], ['🤭', 'hand over mouth'],
  ['🤔', 'thinking hmm'], ['🤐', 'zipper mouth'], ['😐', 'neutral'], ['😑', 'expressionless'],
  ['😶', 'no mouth'], ['😏', 'smirk'], ['😒', 'unamused'], ['🙄', 'roll eyes'],
  ['😬', 'grimace'], ['🤥', 'liar lying'], ['😌', 'relieved'], ['😔', 'pensive sad'],
  ['😴', 'sleeping zzz'], ['😪', 'sleepy'], ['🤤', 'drool'], ['🥱', 'yawn tired'],
  ['😷', 'mask sick'], ['🤒', 'thermometer ill'], ['🤕', 'bandage hurt'], ['🤢', 'nauseated sick'],
  ['🤮', 'vomit'], ['🤧', 'sneeze cold'], ['🥵', 'hot'], ['🥶', 'cold freezing'],
  ['🥴', 'woozy'], ['😵', 'dizzy'], ['🤯', 'mind blown'], ['🤠', 'cowboy'],
  ['🥳', 'party celebrate'], ['😎', 'sunglasses cool'], ['🤓', 'nerd glasses'], ['🧐', 'monocle'],
  ['😕', 'confused'], ['😟', 'worried'], ['🙁', 'frown'], ['☹️', 'frown sad'],
  ['😮', 'shock open mouth'], ['😯', 'hushed'], ['😲', 'astonished'], ['😳', 'flushed'],
  ['🥺', 'pleading'], ['😦', 'frown open'], ['😧', 'anguished'], ['😨', 'fearful'],
  ['😰', 'cold sweat'], ['😥', 'sad sweat'], ['😢', 'crying tear'], ['😭', 'sob crying'],
  ['😱', 'scream fear'], ['😖', 'confounded'], ['😣', 'persevere'], ['😞', 'disappointed'],
  ['😓', 'downcast sweat'], ['😩', 'weary'], ['😫', 'tired'], ['😤', 'huff angry'],
  ['😡', 'angry rage'], ['😠', 'angry'], ['🤬', 'cursing angry'], ['😈', 'devil smile'],
  ['👿', 'devil angry'], ['💀', 'skull'], ['☠️', 'skull bones'], ['💩', 'poop'],
  ['🤡', 'clown'], ['👹', 'ogre'], ['👺', 'goblin'], ['👻', 'ghost'],
  ['👽', 'alien'], ['🤖', 'robot'], ['😺', 'cat smile'], ['😸', 'cat grin'],
  ['😹', 'cat joy'], ['😻', 'cat love'], ['😼', 'cat smirk'], ['😽', 'cat kiss'],
  ['🙀', 'cat scream'], ['😿', 'cat cry'], ['😾', 'cat pouting'],
  ['❤️', 'heart love red'], ['🧡', 'orange heart'], ['💛', 'yellow heart'], ['💚', 'green heart'],
  ['💙', 'blue heart'], ['💜', 'purple heart'], ['🖤', 'black heart'], ['🤍', 'white heart'],
  ['🤎', 'brown heart'], ['💔', 'broken heart'], ['❣️', 'heart exclamation'], ['💕', 'two hearts'],
  ['💞', 'revolving hearts'], ['💓', 'beating heart'], ['💗', 'growing heart'], ['💖', 'sparkling heart'],
  ['💘', 'arrow heart cupid'], ['💝', 'gift heart'], ['💟', 'heart decoration'],
];

const PEOPLE: [string, string][] = [
  ['👋', 'wave hello hi'], ['🤚', 'raised hand back'], ['🖐️', 'hand fingers'], ['✋', 'raised hand stop'],
  ['🖖', 'vulcan salute'], ['👌', 'ok perfect'], ['🤌', 'pinched'], ['🤏', 'pinch small'],
  ['✌️', 'victory peace'], ['🤞', 'crossed fingers'], ['🤟', 'love you sign'], ['🤘', 'rock horns'],
  ['🤙', 'call me'], ['👈', 'point left'], ['👉', 'point right'], ['👆', 'point up'],
  ['🖕', 'middle finger'], ['👇', 'point down'], ['☝️', 'index pointing up'], ['👍', 'thumbs up like'],
  ['👎', 'thumbs down dislike'], ['✊', 'raised fist'], ['👊', 'fist bump'], ['🤛', 'left fist'],
  ['🤜', 'right fist'], ['👏', 'clap applause'], ['🙌', 'raise hands celebrate'], ['👐', 'open hands'],
  ['🤲', 'palms up'], ['🤝', 'handshake'], ['🙏', 'pray thanks'], ['💪', 'muscle strong'],
  ['🦾', 'mechanical arm'], ['🦿', 'mechanical leg'], ['🦵', 'leg'], ['🦶', 'foot'],
  ['👂', 'ear'], ['🦻', 'ear hearing aid'], ['👃', 'nose'], ['🧠', 'brain'],
  ['🫀', 'heart anatomy'], ['🫁', 'lungs'], ['🦷', 'tooth'], ['🦴', 'bone'],
  ['👀', 'eyes look'], ['👁️', 'eye'], ['👅', 'tongue'], ['👄', 'lips mouth'],
  ['👶', 'baby'], ['🧒', 'child'], ['👦', 'boy'], ['👧', 'girl'],
  ['🧑', 'person'], ['👨', 'man'], ['👩', 'woman'], ['🧓', 'older person'],
  ['👴', 'old man'], ['👵', 'old woman'], ['🙍', 'frown person'], ['🙎', 'pouting person'],
  ['🙅', 'no gesture'], ['🙆', 'ok gesture'], ['💁', 'tipping hand'], ['🙋', 'raise hand'],
  ['🙇', 'bow'], ['🤦', 'facepalm'], ['🤷', 'shrug'],
];

const ANIMALS: [string, string][] = [
  ['🐶', 'dog puppy'], ['🐱', 'cat kitten'], ['🐭', 'mouse'], ['🐹', 'hamster'],
  ['🐰', 'rabbit bunny'], ['🦊', 'fox'], ['🐻', 'bear'], ['🐼', 'panda'],
  ['🐨', 'koala'], ['🐯', 'tiger'], ['🦁', 'lion'], ['🐮', 'cow'],
  ['🐷', 'pig'], ['🐽', 'pig nose'], ['🐸', 'frog'], ['🐵', 'monkey'],
  ['🙈', 'see no evil'], ['🙉', 'hear no evil'], ['🙊', 'speak no evil'], ['🐒', 'monkey'],
  ['🐔', 'chicken'], ['🐧', 'penguin'], ['🐦', 'bird'], ['🐤', 'baby chick'],
  ['🐣', 'hatching chick'], ['🦆', 'duck'], ['🦅', 'eagle'], ['🦉', 'owl'],
  ['🦇', 'bat'], ['🐺', 'wolf'], ['🐗', 'boar'], ['🐴', 'horse'],
  ['🦄', 'unicorn'], ['🐝', 'bee'], ['🐛', 'caterpillar'], ['🦋', 'butterfly'],
  ['🐌', 'snail'], ['🐞', 'ladybug'], ['🐜', 'ant'], ['🦗', 'cricket'],
  ['🕷️', 'spider'], ['🦂', 'scorpion'], ['🐢', 'turtle'], ['🐍', 'snake'],
  ['🦎', 'lizard'], ['🦖', 'dinosaur t-rex'], ['🦕', 'sauropod'], ['🐙', 'octopus'],
  ['🦑', 'squid'], ['🦐', 'shrimp'], ['🦀', 'crab'], ['🐡', 'blowfish'],
  ['🐠', 'fish tropical'], ['🐟', 'fish'], ['🐬', 'dolphin'], ['🐳', 'whale'],
  ['🐋', 'whale spout'], ['🦈', 'shark'], ['🐊', 'crocodile'], ['🐅', 'tiger'],
  ['🐆', 'leopard'], ['🦓', 'zebra'], ['🦍', 'gorilla'], ['🐘', 'elephant'],
  ['🦏', 'rhino'], ['🐪', 'camel'], ['🐫', 'camel two-hump'], ['🦒', 'giraffe'],
  ['🐃', 'water buffalo'], ['🐂', 'ox'], ['🐄', 'cow'], ['🐎', 'horse running'],
  ['🐖', 'pig'], ['🐏', 'ram'], ['🐑', 'sheep'], ['🐐', 'goat'],
  ['🦌', 'deer'], ['🐕', 'dog'], ['🐩', 'poodle'], ['🐈', 'cat'],
  ['🐓', 'rooster'], ['🦃', 'turkey'], ['🦚', 'peacock'], ['🦜', 'parrot'],
  ['🌵', 'cactus'], ['🎄', 'christmas tree'], ['🌲', 'evergreen tree'], ['🌳', 'deciduous tree'],
  ['🌴', 'palm tree'], ['🌱', 'seedling'], ['🌿', 'herb'], ['☘️', 'shamrock'],
  ['🍀', 'four leaf clover lucky'], ['🍃', 'leaves'], ['🍂', 'fallen leaves'], ['🍁', 'maple leaf'],
  ['🌾', 'wheat'], ['🌺', 'hibiscus'], ['🌻', 'sunflower'], ['🌹', 'rose'],
  ['🌷', 'tulip'], ['🌼', 'blossom'], ['🌸', 'cherry blossom'], ['💐', 'bouquet'],
];

const FOOD: [string, string][] = [
  ['🍏', 'green apple'], ['🍎', 'apple red'], ['🍐', 'pear'], ['🍊', 'orange'],
  ['🍋', 'lemon'], ['🍌', 'banana'], ['🍉', 'watermelon'], ['🍇', 'grapes'],
  ['🍓', 'strawberry'], ['🫐', 'blueberries'], ['🍈', 'melon'], ['🍒', 'cherries'],
  ['🍑', 'peach'], ['🥭', 'mango'], ['🍍', 'pineapple'], ['🥥', 'coconut'],
  ['🥝', 'kiwi'], ['🍅', 'tomato'], ['🍆', 'eggplant'], ['🥑', 'avocado'],
  ['🥦', 'broccoli'], ['🥬', 'leafy greens'], ['🥒', 'cucumber'], ['🌶️', 'pepper hot'],
  ['🫑', 'bell pepper'], ['🌽', 'corn'], ['🥕', 'carrot'], ['🧄', 'garlic'],
  ['🧅', 'onion'], ['🥔', 'potato'], ['🍠', 'sweet potato'], ['🥐', 'croissant'],
  ['🥯', 'bagel'], ['🍞', 'bread'], ['🥖', 'baguette'], ['🥨', 'pretzel'],
  ['🧀', 'cheese'], ['🥚', 'egg'], ['🍳', 'fried egg'], ['🧈', 'butter'],
  ['🥞', 'pancakes'], ['🧇', 'waffle'], ['🥓', 'bacon'], ['🥩', 'steak'],
  ['🍗', 'chicken leg'], ['🍖', 'meat bone'], ['🌭', 'hot dog'], ['🍔', 'burger'],
  ['🍟', 'fries'], ['🍕', 'pizza'], ['🥪', 'sandwich'], ['🌮', 'taco'],
  ['🌯', 'burrito'], ['🥙', 'stuffed flatbread'], ['🧆', 'falafel'], ['🥘', 'paella'],
  ['🍝', 'spaghetti'], ['🍜', 'ramen noodles'], ['🍲', 'pot of food'], ['🍛', 'curry'],
  ['🍣', 'sushi'], ['🍱', 'bento'], ['🥟', 'dumpling'], ['🍤', 'shrimp'],
  ['🍙', 'rice ball'], ['🍚', 'rice'], ['🍘', 'rice cracker'], ['🍥', 'fish cake'],
  ['🥮', 'moon cake'], ['🍢', 'oden'], ['🍡', 'dango'], ['🍧', 'shaved ice'],
  ['🍨', 'ice cream'], ['🍦', 'soft ice cream'], ['🥧', 'pie'], ['🧁', 'cupcake'],
  ['🍰', 'cake'], ['🎂', 'birthday cake'], ['🍮', 'custard'], ['🍭', 'lollipop'],
  ['🍬', 'candy'], ['🍫', 'chocolate'], ['🍿', 'popcorn'], ['🍩', 'donut'],
  ['🍪', 'cookie'], ['🌰', 'chestnut'], ['🥜', 'peanuts'], ['🍯', 'honey'],
  ['🥛', 'milk'], ['🍼', 'baby bottle'], ['☕', 'coffee'], ['🍵', 'tea'],
  ['🧃', 'juice'], ['🥤', 'cup straw'], ['🍶', 'sake'], ['🍺', 'beer'],
  ['🍻', 'cheers beers'], ['🥂', 'cheers wine'], ['🍷', 'wine'], ['🥃', 'whiskey'],
  ['🍸', 'cocktail'], ['🍹', 'tropical drink'], ['🍾', 'champagne'], ['🧊', 'ice cube'],
];

const ACTIVITY: [string, string][] = [
  ['⚽', 'soccer football'], ['🏀', 'basketball'], ['🏈', 'football american'], ['⚾', 'baseball'],
  ['🥎', 'softball'], ['🎾', 'tennis'], ['🏐', 'volleyball'], ['🏉', 'rugby'],
  ['🎱', '8 ball pool'], ['🪀', 'yo yo'], ['🏓', 'ping pong'], ['🏸', 'badminton'],
  ['🥅', 'goal'], ['🏒', 'hockey'], ['🏑', 'field hockey'], ['🥍', 'lacrosse'],
  ['🏏', 'cricket'], ['⛳', 'golf'], ['🪁', 'kite'], ['🏹', 'bow arrow'],
  ['🎣', 'fishing'], ['🤿', 'diving'], ['🥊', 'boxing'], ['🥋', 'martial arts'],
  ['🎽', 'running shirt'], ['🛹', 'skateboard'], ['🛼', 'roller skate'], ['🛷', 'sled'],
  ['⛸️', 'ice skate'], ['🥌', 'curling'], ['🎿', 'ski'], ['⛷️', 'skier'],
  ['🏂', 'snowboarder'], ['🪂', 'parachute'], ['🏋️', 'weight lifter'], ['🤸', 'cartwheel'],
  ['🤼', 'wrestling'], ['🤽', 'water polo'], ['🤾', 'handball'], ['🤺', 'fencing'],
  ['🏇', 'horse racing'], ['🧘', 'meditation yoga'], ['🏄', 'surfing'], ['🏊', 'swim'],
  ['🚣', 'rowing'], ['🧗', 'climbing'], ['🚴', 'biking'], ['🚵', 'mountain biking'],
  ['🎬', 'movie clapper'], ['🎤', 'microphone'], ['🎧', 'headphones'], ['🎼', 'score'],
  ['🎵', 'music note'], ['🎶', 'music notes'], ['🎹', 'piano'], ['🥁', 'drum'],
  ['🎷', 'saxophone'], ['🎺', 'trumpet'], ['🎸', 'guitar'], ['🪕', 'banjo'],
  ['🎻', 'violin'], ['🎲', 'dice'], ['🧩', 'puzzle'], ['🎯', 'target'],
  ['🎳', 'bowling'], ['🎮', 'video game'], ['🎰', 'slot machine'], ['🧸', 'teddy bear'],
];

const TRAVEL: [string, string][] = [
  ['🚗', 'car'], ['🚕', 'taxi'], ['🚙', 'suv'], ['🚌', 'bus'],
  ['🚎', 'trolleybus'], ['🏎️', 'race car'], ['🚓', 'police car'], ['🚑', 'ambulance'],
  ['🚒', 'fire engine'], ['🚐', 'minibus'], ['🛻', 'pickup truck'], ['🚚', 'delivery truck'],
  ['🚛', 'articulated lorry'], ['🚜', 'tractor'], ['🛵', 'scooter'], ['🏍️', 'motorcycle'],
  ['🛺', 'auto rickshaw'], ['🚲', 'bicycle'], ['🛴', 'kick scooter'], ['🛹', 'skateboard'],
  ['🚏', 'bus stop'], ['🛣️', 'motorway'], ['🛤️', 'railway track'], ['⛽', 'fuel pump'],
  ['🚨', 'siren'], ['🚥', 'traffic light horizontal'], ['🚦', 'traffic light vertical'],
  ['🛑', 'stop sign'], ['🚧', 'construction'], ['⚓', 'anchor'], ['⛵', 'sailboat'],
  ['🛶', 'canoe'], ['🚤', 'speedboat'], ['🛳️', 'ship'], ['⛴️', 'ferry'],
  ['🚢', 'ship boat'], ['✈️', 'airplane'], ['🛩️', 'small airplane'], ['🛫', 'departure'],
  ['🛬', 'arrival'], ['🪂', 'parachute'], ['💺', 'seat'], ['🚀', 'rocket'],
  ['🛸', 'ufo'], ['🚁', 'helicopter'], ['🛶', 'canoe'], ['🚂', 'locomotive'],
  ['🚆', 'train'], ['🚇', 'metro'], ['🚊', 'tram'], ['🚉', 'station'],
  ['🌍', 'earth europe africa'], ['🌎', 'earth americas'], ['🌏', 'earth asia'],
  ['🗺️', 'world map'], ['🗾', 'japan'], ['🧭', 'compass'], ['🏔️', 'mountain snow'],
  ['⛰️', 'mountain'], ['🌋', 'volcano'], ['🏕️', 'camping'], ['🏖️', 'beach'],
  ['🏜️', 'desert'], ['🏝️', 'desert island'], ['🏞️', 'national park'], ['🏟️', 'stadium'],
  ['🏛️', 'classical building'], ['🏗️', 'building construction'], ['🏘️', 'houses'], ['🏚️', 'derelict house'],
  ['🏠', 'house'], ['🏡', 'house garden'], ['🏢', 'office'], ['🏣', 'japanese post'],
  ['🏤', 'post office'], ['🏥', 'hospital'], ['🏦', 'bank'], ['🏨', 'hotel'],
  ['🏩', 'love hotel'], ['🏪', 'convenience store'], ['🏫', 'school'], ['🏬', 'department store'],
  ['🏭', 'factory'], ['🏯', 'castle japanese'], ['🏰', 'castle'], ['💒', 'wedding'],
  ['🗼', 'tokyo tower'], ['🗽', 'statue liberty'], ['⛪', 'church'], ['🕌', 'mosque'],
  ['🕍', 'synagogue'], ['⛩️', 'shinto shrine'],
];

const OBJECTS: [string, string][] = [
  ['⌚', 'watch'], ['📱', 'phone mobile'], ['📲', 'phone call'], ['💻', 'laptop'],
  ['⌨️', 'keyboard'], ['🖥️', 'desktop computer'], ['🖨️', 'printer'], ['🖱️', 'mouse computer'],
  ['🖲️', 'trackball'], ['🕹️', 'joystick'], ['🗜️', 'clamp'], ['💽', 'minidisc'],
  ['💾', 'floppy disk save'], ['💿', 'cd'], ['📀', 'dvd'], ['📼', 'videotape'],
  ['📷', 'camera'], ['📸', 'camera flash'], ['📹', 'video camera'], ['🎥', 'movie camera'],
  ['📽️', 'projector'], ['🎞️', 'film frames'], ['📞', 'telephone'], ['☎️', 'phone classic'],
  ['📟', 'pager'], ['📠', 'fax'], ['📺', 'tv'], ['📻', 'radio'],
  ['🎙️', 'studio mic'], ['🎚️', 'level slider'], ['🎛️', 'control knobs'], ['🧭', 'compass'],
  ['⏱️', 'stopwatch'], ['⏲️', 'timer'], ['⏰', 'alarm clock'], ['🕰️', 'mantelpiece clock'],
  ['🌡️', 'thermometer'], ['🔋', 'battery'], ['🔌', 'plug'], ['💡', 'lightbulb idea'],
  ['🔦', 'flashlight'], ['🕯️', 'candle'], ['🧯', 'fire extinguisher'], ['🛢️', 'oil drum'],
  ['💸', 'money flying'], ['💵', 'dollar'], ['💴', 'yen'], ['💶', 'euro'],
  ['💷', 'pound'], ['💰', 'money bag'], ['💳', 'credit card'], ['💎', 'gem diamond'],
  ['⚖️', 'balance scale'], ['🧰', 'toolbox'], ['🔧', 'wrench'], ['🔨', 'hammer'],
  ['⚒️', 'hammer pick'], ['🛠️', 'hammer wrench'], ['⛏️', 'pick'], ['🔩', 'nut bolt'],
  ['⚙️', 'gear'], ['🧲', 'magnet'], ['🔫', 'water pistol'], ['💣', 'bomb'],
  ['🧨', 'firecracker'], ['🔪', 'knife'], ['🗡️', 'dagger'], ['⚔️', 'crossed swords'],
  ['🛡️', 'shield'], ['🚬', 'cigarette'], ['⚰️', 'coffin'], ['⚱️', 'urn'],
  ['🏺', 'amphora'], ['🔮', 'crystal ball'], ['📿', 'prayer beads'], ['🧿', 'nazar'],
  ['💈', 'barber'], ['🔬', 'microscope'], ['🔭', 'telescope'], ['📡', 'satellite antenna'],
  ['💉', 'syringe'], ['🩸', 'blood drop'], ['💊', 'pill'], ['🩹', 'bandage'],
  ['🩺', 'stethoscope'], ['🚪', 'door'], ['🛏️', 'bed'], ['🛋️', 'couch'],
  ['🪑', 'chair'], ['🚽', 'toilet'], ['🚿', 'shower'], ['🛁', 'bathtub'],
  ['🧴', 'lotion bottle'], ['🧷', 'safety pin'], ['🧹', 'broom'], ['🧺', 'basket'],
  ['🧻', 'toilet paper'], ['🧼', 'soap'], ['🧽', 'sponge'], ['📚', 'books'],
  ['📖', 'open book'], ['📓', 'notebook'], ['📔', 'notebook decorative'], ['📒', 'ledger'],
  ['📕', 'book closed'], ['📗', 'green book'], ['📘', 'blue book'], ['📙', 'orange book'],
  ['📰', 'newspaper'], ['🗞️', 'rolled newspaper'], ['🔖', 'bookmark'], ['🏷️', 'label'],
  ['💌', 'love letter'], ['📧', 'email'], ['📨', 'incoming envelope'], ['📩', 'envelope arrow'],
  ['📤', 'outbox'], ['📥', 'inbox'], ['📦', 'package'], ['📫', 'mailbox flag up'],
  ['📪', 'mailbox flag down'], ['📬', 'open mailbox flag up'], ['📭', 'open mailbox'], ['📮', 'postbox'],
];

const SYMBOLS: [string, string][] = [
  ['💯', 'hundred 100'], ['💢', 'anger'], ['💥', 'collision boom'], ['💫', 'dizzy'],
  ['💦', 'sweat drops'], ['💨', 'dash wind'], ['🕳️', 'hole'], ['💬', 'speech bubble'],
  ['🗨️', 'left speech'], ['🗯️', 'right anger'], ['💭', 'thought bubble'], ['💤', 'zzz sleep'],
  ['🚫', 'prohibited'], ['⛔', 'no entry'], ['📛', 'name badge'], ['🚸', 'children crossing'],
  ['⚠️', 'warning'], ['🚷', 'no pedestrians'], ['🚯', 'no littering'], ['🚳', 'no bicycles'],
  ['🚱', 'non potable water'], ['🔞', '18+'], ['📵', 'no phones'], ['🚭', 'no smoking'],
  ['❗', 'exclamation'], ['❕', 'white exclamation'], ['❓', 'question'], ['❔', 'white question'],
  ['‼️', 'double exclamation'], ['⁉️', 'interrobang'], ['🔅', 'low brightness'], ['🔆', 'high brightness'],
  ['〽️', 'part alternation'], ['⚜️', 'fleur de lis'], ['🔱', 'trident'], ['📛', 'badge'],
  ['🔰', 'beginner'], ['♻️', 'recycle'], ['✅', 'check mark green'], ['🈯', 'reserved'],
  ['💹', 'chart up yen'], ['❇️', 'sparkle'], ['✳️', 'asterisk'], ['❎', 'cross mark button'],
  ['🌐', 'globe meridians'], ['💠', 'diamond dot'], ['Ⓜ️', 'm circled'], ['🌀', 'cyclone'],
  ['💤', 'zzz'], ['🏧', 'atm'], ['🚾', 'water closet'], ['♿', 'wheelchair'],
  ['🅿️', 'parking'], ['🈳', 'vacancy'], ['🈂️', 'service charge'], ['🛂', 'passport control'],
  ['🛃', 'customs'], ['🛄', 'baggage claim'], ['🛅', 'left luggage'], ['🚹', 'mens'],
  ['🚺', 'womens'], ['🚼', 'baby symbol'], ['🚻', 'restroom'], ['🚮', 'litter'],
  ['🎦', 'cinema'], ['📶', 'antenna bars'], ['🈁', 'here japanese'], ['🆗', 'ok button'],
  ['🆙', 'up button'], ['🆒', 'cool button'], ['🆕', 'new button'], ['🆓', 'free button'],
  ['0️⃣', 'zero'], ['1️⃣', 'one'], ['2️⃣', 'two'], ['3️⃣', 'three'],
  ['4️⃣', 'four'], ['5️⃣', 'five'], ['6️⃣', 'six'], ['7️⃣', 'seven'],
  ['8️⃣', 'eight'], ['9️⃣', 'nine'], ['🔟', 'ten'], ['🔢', 'numbers'],
  ['🔣', 'symbols'], ['🔤', 'abc'], ['🔠', 'letters uppercase'], ['🔡', 'letters lowercase'],
  ['🔥', 'fire'], ['✨', 'sparkles'], ['⭐', 'star'], ['🌟', 'glowing star'],
  ['💫', 'dizzy star'], ['🌈', 'rainbow'], ['☀️', 'sun'], ['🌤️', 'sun small cloud'],
  ['⛅', 'sun behind cloud'], ['🌥️', 'sun large cloud'], ['☁️', 'cloud'], ['🌦️', 'sun rain'],
  ['🌧️', 'cloud rain'], ['⛈️', 'thunder rain'], ['🌩️', 'cloud lightning'], ['🌨️', 'cloud snow'],
  ['❄️', 'snowflake'], ['☃️', 'snowman with snow'], ['⛄', 'snowman'], ['🌬️', 'wind face'],
  ['💨', 'dash'], ['🌪️', 'tornado'], ['🌫️', 'fog'], ['☂️', 'umbrella'],
  ['☔', 'umbrella rain'], ['⚡', 'high voltage'], ['🌊', 'water wave'],
];

const FLAGS: [string, string][] = [
  ['🏁', 'checkered flag'], ['🚩', 'triangular flag'], ['🎌', 'crossed flags'], ['🏴', 'black flag'],
  ['🏳️', 'white flag'], ['🏳️‍🌈', 'rainbow flag pride'], ['🏴‍☠️', 'pirate flag'],
  ['🇪🇸', 'spain es'], ['🇺🇸', 'united states us'], ['🇲🇽', 'mexico mx'], ['🇨🇦', 'canada ca'],
  ['🇧🇷', 'brazil br'], ['🇦🇷', 'argentina ar'], ['🇫🇷', 'france fr'], ['🇮🇹', 'italy it'],
  ['🇩🇪', 'germany de'], ['🇬🇧', 'united kingdom uk gb'], ['🇮🇪', 'ireland ie'], ['🇵🇹', 'portugal pt'],
  ['🇳🇱', 'netherlands nl'], ['🇧🇪', 'belgium be'], ['🇦🇹', 'austria at'], ['🇨🇭', 'switzerland ch'],
  ['🇸🇪', 'sweden se'], ['🇳🇴', 'norway no'], ['🇩🇰', 'denmark dk'], ['🇫🇮', 'finland fi'],
  ['🇮🇸', 'iceland is'], ['🇵🇱', 'poland pl'], ['🇨🇿', 'czech cz'], ['🇸🇰', 'slovakia sk'],
  ['🇭🇺', 'hungary hu'], ['🇷🇴', 'romania ro'], ['🇧🇬', 'bulgaria bg'], ['🇬🇷', 'greece gr'],
  ['🇹🇷', 'turkey tr'], ['🇷🇺', 'russia ru'], ['🇺🇦', 'ukraine ua'], ['🇨🇳', 'china cn'],
  ['🇯🇵', 'japan jp'], ['🇰🇷', 'korea kr'], ['🇮🇳', 'india in'], ['🇮🇩', 'indonesia id'],
  ['🇵🇭', 'philippines ph'], ['🇻🇳', 'vietnam vn'], ['🇹🇭', 'thailand th'], ['🇲🇾', 'malaysia my'],
  ['🇸🇬', 'singapore sg'], ['🇦🇺', 'australia au'], ['🇳🇿', 'new zealand nz'], ['🇿🇦', 'south africa za'],
];

const CATEGORIES: Category[] = [
  cat('smileys', '😀', SMILEYS),
  cat('people', '👋', PEOPLE),
  cat('animals', '🐶', ANIMALS),
  cat('food', '🍔', FOOD),
  cat('activity', '⚽', ACTIVITY),
  cat('travel', '✈️', TRAVEL),
  cat('objects', '💡', OBJECTS),
  cat('symbols', '❗', SYMBOLS),
  cat('flags', '🏁', FLAGS),
];

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose?: () => void;
}

export const EmojiPicker: React.FC<EmojiPickerProps> = ({ onSelect }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const [activeCat, setActiveCat] = useState<string>('smileys');
  const [recents, setRecents] = useState<string[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(RECENTS_KEY);
        if (raw) setRecents(JSON.parse(raw));
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const handlePick = useCallback(
    async (emoji: string) => {
      onSelect(emoji);
      try {
        const next = [emoji, ...recents.filter((e) => e !== emoji)].slice(0, MAX_RECENTS);
        setRecents(next);
        await AsyncStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    },
    [onSelect, recents]
  );

  const visibleEmojis = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length > 0) {
      const all = CATEGORIES.flatMap((c) => c.emojis);
      return all.filter((entry) => entry.k.includes(q) || entry.e.includes(q)).map((e) => e.e);
    }
    if (activeCat === 'recents') return recents;
    const c = CATEGORIES.find((c) => c.id === activeCat);
    return c ? c.emojis.map((e) => e.e) : [];
  }, [query, activeCat, recents]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 16, flex: 1 },
        search: {
          backgroundColor: theme.colors.card || '#F0F0F0',
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 10,
          marginBottom: 8,
          color: theme.colors.text,
        },
        tabs: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          marginBottom: 8,
          paddingVertical: 4,
        },
        tab: {
          width: 36,
          height: 36,
          borderRadius: 8,
          alignItems: 'center',
          justifyContent: 'center',
        },
        tabActive: {
          backgroundColor: theme.colors.card || '#E5E5E5',
        },
        tabIcon: { fontSize: 20 },
        grid: { paddingBottom: 24 },
        cell: {
          width: '12.5%',
          aspectRatio: 1,
          alignItems: 'center',
          justifyContent: 'center',
        },
        emoji: { fontSize: 28 },
        empty: { padding: 32, alignItems: 'center' },
      }),
    [theme]
  );

  return (
    <View style={styles.root}>
      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder={t('chat.emojiSearch') || ''}
        placeholderTextColor={theme.colors.textSecondary || '#999'}
        autoCorrect={false}
        autoCapitalize="none"
      />

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs}>
        {recents.length > 0 && (
          <TouchableOpacity
            style={[styles.tab, activeCat === 'recents' && styles.tabActive]}
            onPress={() => {
              setActiveCat('recents');
              setQuery('');
            }}
            activeOpacity={0.7}
          >
            <Ionicons name="time-outline" size={20} color={theme.colors.text} />
          </TouchableOpacity>
        )}
        {CATEGORIES.map((c) => (
          <TouchableOpacity
            key={c.id}
            style={[styles.tab, activeCat === c.id && styles.tabActive]}
            onPress={() => {
              setActiveCat(c.id);
              setQuery('');
            }}
            activeOpacity={0.7}
          >
            <ThemedText style={styles.tabIcon}>{c.icon}</ThemedText>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {visibleEmojis.length === 0 ? (
        <View style={styles.empty}>
          <ThemedText>{t('chat.emojiNoResults')}</ThemedText>
        </View>
      ) : (
        <FlatList
          data={visibleEmojis}
          keyExtractor={(item, idx) => `${item}-${idx}`}
          numColumns={8}
          contentContainerStyle={styles.grid}
          showsVerticalScrollIndicator={false}
          // Force a fresh layout when columns count remains constant but data changes
          extraData={`${activeCat}-${query}`}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.cell}
              onPress={() => handlePick(item)}
              activeOpacity={0.6}
            >
              <ThemedText style={styles.emoji}>{item}</ThemedText>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
};

export default EmojiPicker;
